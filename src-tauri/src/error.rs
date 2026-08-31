use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("Audio error: {0}")]
    Audio(String),

    #[error("OpenAI request failed: {0}")]
    OpenAi(String),

    #[error("pyannote request failed: {0}")]
    Pyannote(String),

    #[error("Credential storage error: {0}")]
    Credential(String),

    #[error("File error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Window error: {0}")]
    Window(String),

    #[error("Invalid request: {0}")]
    Validation(String),

    #[error("{0} was not found")]
    NotFound(&'static str),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
