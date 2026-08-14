use std::{collections::HashMap, time::Duration};

use futures_util::{stream, StreamExt};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    domain::{Person, TranscriptSegment},
    error::{AppError, AppResult},
};

const RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
const CLEANUP_MODEL: &str = "gpt-5.6-luna";
const MAX_BATCH_CHARACTERS: usize = 12_000;
const MAX_BATCH_SEGMENTS: usize = 60;
const MAX_PARALLEL_REQUESTS: usize = 3;
const MAX_REQUEST_ATTEMPTS: u32 = 2;

const CLEANUP_INSTRUCTIONS: &str = r#"You are a conservative meeting-transcript copy editor.

Return exactly one result for every input segment, preserving every id and the original order.
Correct only highly likely speech-recognition mistakes, punctuation, capitalization, and word boundaries. Use the meeting title, project, participant names, and surrounding segments to restore obvious proper nouns. Make sentences flow naturally across adjacent segments from the same speaker, but keep words in their original segment.

Never summarize, paraphrase, add facts, remove meaningful speech, change speaker identity, combine different speakers, or guess words that are not supported by the transcript. Preserve hesitations when they carry meaning. Concurrent speakers remain separate. If a correction is uncertain, keep the original text."#;

#[derive(Debug, Clone)]
pub struct CleanupContext {
    pub meeting_id: String,
    pub meeting_title: String,
    pub project_name: Option<String>,
    pub people: Vec<Person>,
}

#[derive(Debug, Serialize)]
struct InputSegment<'a> {
    id: &'a str,
    speaker: &'a str,
    start_ms: i64,
    text: &'a str,
}

#[derive(Debug, Deserialize)]
struct CleanupPayload {
    segments: Vec<CleanedSegment>,
}

#[derive(Debug, Deserialize)]
struct CleanedSegment {
    id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct ResponsesEnvelope {
    status: String,
    #[serde(default)]
    output: Vec<ResponseOutput>,
    incomplete_details: Option<IncompleteDetails>,
}

#[derive(Debug, Deserialize)]
struct IncompleteDetails {
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ResponseOutput {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    content: Vec<ResponseContent>,
}

#[derive(Debug, Deserialize)]
struct ResponseContent {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
    refusal: Option<String>,
}

pub async fn refine_transcript(
    client: &reqwest::Client,
    api_key: &str,
    context: &CleanupContext,
    segments: &[TranscriptSegment],
) -> AppResult<Vec<TranscriptSegment>> {
    if segments.is_empty() {
        return Ok(Vec::new());
    }

    let batches = segment_batches(segments);
    let results = stream::iter(batches.into_iter().enumerate().map(|(index, batch)| {
        let client = client.clone();
        let api_key = api_key.to_string();
        let context = context.clone();

        async move {
            let refined = request_cleanup(&client, &api_key, &context, &batch).await?;
            Ok::<_, AppError>((index, refined))
        }
    }))
    .buffer_unordered(MAX_PARALLEL_REQUESTS)
    .collect::<Vec<_>>()
    .await;

    let mut completed = Vec::with_capacity(results.len());
    for result in results {
        completed.push(result?);
    }
    completed.sort_by_key(|(index, _)| *index);

    Ok(completed
        .into_iter()
        .flat_map(|(_, segments)| segments)
        .collect())
}

async fn request_cleanup(
    client: &reqwest::Client,
    api_key: &str,
    context: &CleanupContext,
    segments: &[TranscriptSegment],
) -> AppResult<Vec<TranscriptSegment>> {
    let request_body = cleanup_request(context, segments)?;
    let mut attempt = 0_u32;

    loop {
        attempt += 1;
        let response = client
            .post(RESPONSES_URL)
            .bearer_auth(api_key)
            .json(&request_body)
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(_) if attempt < MAX_REQUEST_ATTEMPTS => {
                tokio::time::sleep(retry_delay(attempt)).await;
                continue;
            }
            Err(error) => {
                return Err(AppError::OpenAi(format!(
                    "cleanup model={CLEANUP_MODEL} network_error={error}",
                )));
            }
        };
        let status = response.status();
        let body = response.text().await.map_err(|error| {
            AppError::OpenAi(format!(
                "cleanup model={CLEANUP_MODEL} response_read_error={error}",
            ))
        })?;

        if !status.is_success() {
            if retryable_status(status) && attempt < MAX_REQUEST_ATTEMPTS {
                tokio::time::sleep(retry_delay(attempt)).await;
                continue;
            }
            return Err(AppError::OpenAi(format!(
                "cleanup model={CLEANUP_MODEL} http_status={} detail={}",
                status.as_u16(),
                response_error_detail(&body),
            )));
        }

        let envelope = serde_json::from_str::<ResponsesEnvelope>(&body).map_err(|error| {
            AppError::OpenAi(format!(
                "cleanup model={CLEANUP_MODEL} unexpected_response={error} response_bytes={}",
                body.len(),
            ))
        })?;
        let output_text = response_output_text(&envelope)?;
        let payload = serde_json::from_str::<CleanupPayload>(output_text).map_err(|error| {
            AppError::OpenAi(format!(
                "cleanup model={CLEANUP_MODEL} invalid_structured_output={error}",
            ))
        })?;

        return apply_cleanup(segments, payload);
    }
}

fn cleanup_request(
    context: &CleanupContext,
    segments: &[TranscriptSegment],
) -> AppResult<serde_json::Value> {
    let people_by_id = context
        .people
        .iter()
        .map(|person| (person.id.as_str(), person.full_name.as_str()))
        .collect::<HashMap<_, _>>();
    let input_segments = segments
        .iter()
        .map(|segment| InputSegment {
            id: &segment.id,
            speaker: segment
                .person_id
                .as_deref()
                .and_then(|id| people_by_id.get(id).copied())
                .unwrap_or(&segment.speaker_label),
            start_ms: segment.start_ms,
            text: &segment.text,
        })
        .collect::<Vec<_>>();
    let participant_names = context
        .people
        .iter()
        .map(|person| person.full_name.as_str())
        .collect::<Vec<_>>();
    let transcript_context = json!({
        "meeting_title": context.meeting_title,
        "project_name": context.project_name,
        "participant_names": participant_names,
        "segments": input_segments,
    });
    let user_content = serde_json::to_string(&transcript_context)
        .map_err(|error| AppError::Validation(error.to_string()))?;

    Ok(json!({
        "model": CLEANUP_MODEL,
        "store": false,
        "safety_identifier": format!("listen:{}", context.meeting_id),
        "reasoning": { "effort": "none" },
        "input": [
            { "role": "system", "content": CLEANUP_INSTRUCTIONS },
            { "role": "user", "content": user_content }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "refined_transcript",
                "strict": true,
                "schema": cleanup_schema()
            }
        },
        "max_output_tokens": 10_000
    }))
}

fn cleanup_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "segments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "text": { "type": "string" }
                    },
                    "required": ["id", "text"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["segments"],
        "additionalProperties": false
    })
}

fn response_output_text(response: &ResponsesEnvelope) -> AppResult<&str> {
    if response.status != "completed" {
        let reason = response
            .incomplete_details
            .as_ref()
            .and_then(|details| details.reason.as_deref())
            .unwrap_or("unknown");
        return Err(AppError::OpenAi(format!(
            "cleanup model={CLEANUP_MODEL} incomplete reason={reason}",
        )));
    }

    for output in &response.output {
        if output.kind != "message" {
            continue;
        }
        for content in &output.content {
            if content.kind == "refusal" {
                return Err(AppError::OpenAi(format!(
                    "cleanup model={CLEANUP_MODEL} refused detail={}",
                    content.refusal.as_deref().unwrap_or("no detail"),
                )));
            }
            if content.kind == "output_text" {
                return content.text.as_deref().ok_or_else(|| {
                    AppError::OpenAi(format!(
                        "cleanup model={CLEANUP_MODEL} returned empty output",
                    ))
                });
            }
        }
    }

    Err(AppError::OpenAi(format!(
        "cleanup model={CLEANUP_MODEL} returned no message output",
    )))
}

fn apply_cleanup(
    original: &[TranscriptSegment],
    payload: CleanupPayload,
) -> AppResult<Vec<TranscriptSegment>> {
    if payload.segments.len() != original.len() {
        return Err(AppError::Validation(format!(
            "Transcript cleanup returned {} segments instead of {}",
            payload.segments.len(),
            original.len(),
        )));
    }

    let mut refined = Vec::with_capacity(original.len());
    for (source, cleaned) in original.iter().zip(payload.segments) {
        if cleaned.id != source.id {
            return Err(AppError::Validation(
                "Transcript cleanup changed segment identity or order".to_string(),
            ));
        }
        let text = cleaned.text.trim();
        if text.is_empty() {
            return Err(AppError::Validation(format!(
                "Transcript cleanup emptied segment {}",
                source.id,
            )));
        }
        refined.push(TranscriptSegment {
            text: text.to_string(),
            ..source.clone()
        });
    }

    validate_text_volume(original, &refined)?;
    Ok(refined)
}

fn validate_text_volume(
    original: &[TranscriptSegment],
    refined: &[TranscriptSegment],
) -> AppResult<()> {
    let original_characters = text_characters(original).max(1);
    let refined_characters = text_characters(refined);

    if refined_characters * 2 < original_characters
        || refined_characters > original_characters * 3 / 2
    {
        return Err(AppError::Validation(
            "Transcript cleanup changed too much text to apply safely".to_string(),
        ));
    }
    Ok(())
}

fn text_characters(segments: &[TranscriptSegment]) -> usize {
    segments
        .iter()
        .map(|segment| {
            segment
                .text
                .chars()
                .filter(|character| !character.is_whitespace())
                .count()
        })
        .sum()
}

fn segment_batches(segments: &[TranscriptSegment]) -> Vec<Vec<TranscriptSegment>> {
    let mut batches = Vec::new();
    let mut start = 0;

    while start < segments.len() {
        let mut end = start;
        let mut characters = 0;
        while end < segments.len() && end - start < MAX_BATCH_SEGMENTS {
            let next_characters = segments[end].text.chars().count();
            if end > start && characters + next_characters > MAX_BATCH_CHARACTERS {
                break;
            }
            characters += next_characters;
            end += 1;
        }
        batches.push(segments[start..end].to_vec());
        start = end;
    }

    batches
}

fn retryable_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn retry_delay(attempt: u32) -> Duration {
    Duration::from_millis(600 * u64::from(2_u32.pow(attempt.saturating_sub(1))))
}

fn response_error_detail(body: &str) -> String {
    #[derive(Deserialize)]
    struct ErrorEnvelope {
        error: ErrorDetail,
    }

    #[derive(Deserialize)]
    struct ErrorDetail {
        message: String,
    }

    serde_json::from_str::<ErrorEnvelope>(body)
        .ok()
        .map(|response| response.error.message)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| format!("empty error response ({} bytes)", body.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(id: &str, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: id.to_string(),
            meeting_id: "meeting".to_string(),
            speaker_label: "mixed:Speaker A".to_string(),
            person_id: None,
            identity_source: None,
            identity_confidence: None,
            start_ms: 0,
            end_ms: 1_000,
            text: text.to_string(),
        }
    }

    fn context() -> CleanupContext {
        CleanupContext {
            meeting_id: "meeting".to_string(),
            meeting_title: "Codex discussion".to_string(),
            project_name: Some("Listen".to_string()),
            people: Vec::new(),
        }
    }

    #[test]
    fn builds_a_luna_request_with_no_reasoning_and_strict_output() {
        let request =
            cleanup_request(&context(), &[segment("one", "Hearing codecs.")]).expect("request");

        assert_eq!(request["model"], CLEANUP_MODEL);
        assert_eq!(request["reasoning"]["effort"], "none");
        assert_eq!(request["store"], false);
        assert_eq!(request["text"]["format"]["strict"], true);
    }

    #[test]
    fn applies_only_text_from_a_valid_response() {
        let original = vec![segment("one", "Hearing codecs.")];
        let refined = apply_cleanup(
            &original,
            CleanupPayload {
                segments: vec![CleanedSegment {
                    id: "one".to_string(),
                    text: "Hearing Codex.".to_string(),
                }],
            },
        )
        .expect("cleanup");

        assert_eq!(refined[0].text, "Hearing Codex.");
        assert_eq!(refined[0].speaker_label, original[0].speaker_label);
        assert_eq!(refined[0].start_ms, original[0].start_ms);
    }

    #[test]
    fn rejects_missing_or_reordered_segments() {
        let original = vec![segment("one", "One."), segment("two", "Two.")];
        let result = apply_cleanup(
            &original,
            CleanupPayload {
                segments: vec![
                    CleanedSegment {
                        id: "two".to_string(),
                        text: "Two.".to_string(),
                    },
                    CleanedSegment {
                        id: "one".to_string(),
                        text: "One.".to_string(),
                    },
                ],
            },
        );

        assert!(result.is_err());
    }

    #[test]
    fn rejects_a_summary_that_discards_the_transcript() {
        let original = vec![segment(
            "one",
            "This is a reasonably long transcript sentence with several important details.",
        )];
        let result = apply_cleanup(
            &original,
            CleanupPayload {
                segments: vec![CleanedSegment {
                    id: "one".to_string(),
                    text: "Summary.".to_string(),
                }],
            },
        );

        assert!(result.is_err());
    }

    #[test]
    fn batches_long_meetings_without_dropping_segments() {
        let segments = (0..125)
            .map(|index| segment(&index.to_string(), "A short segment."))
            .collect::<Vec<_>>();
        let batches = segment_batches(&segments);

        assert_eq!(batches.len(), 3);
        assert_eq!(batches.iter().map(|batch| batch.len()).sum::<usize>(), 125);
        assert!(batches
            .iter()
            .all(|batch| batch.len() <= MAX_BATCH_SEGMENTS));
    }
}
