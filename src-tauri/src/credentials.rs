use keyring::{Entry, Error as KeyringError};

use crate::error::{AppError, AppResult};

const SERVICE: &str = "app.listen.desktop";
const OPENAI_ACCOUNT: &str = "openai-api-key";
/// Left by versions that sent audio to the hosted pyannote service.
const RETIRED_PYANNOTE_ACCOUNT: &str = "pyannote-api-key";
const RETIRED_VOICEPRINT_PREFIX: &str = "voiceprint-";
const VOICE_PROFILE_KEY_ACCOUNT: &str = "voice-profile-master-key-v1";

pub fn has_openai_key() -> AppResult<bool> {
    has_key(OPENAI_ACCOUNT)
}

fn has_key(account: &str) -> AppResult<bool> {
    match entry(account)?.get_password() {
        Ok(key) => Ok(!key.trim().is_empty()),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(error) => Err(credential_error(error)),
    }
}

pub fn openai_key() -> AppResult<String> {
    read_key(OPENAI_ACCOUNT)
}

pub fn voice_profile_master_key() -> AppResult<Option<String>> {
    match entry(VOICE_PROFILE_KEY_ACCOUNT)?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(credential_error(error)),
    }
}

pub fn set_voice_profile_master_key(value: &str) -> AppResult<()> {
    store_key(VOICE_PROFILE_KEY_ACCOUNT, value).map(|_| ())
}

/// Removes secrets Listen no longer uses: the pyannote API key and
/// per-person pyannote voiceprints from before local processing.
pub fn delete_retired_secrets(person_ids: &[String]) -> AppResult<()> {
    let accounts = std::iter::once(RETIRED_PYANNOTE_ACCOUNT.to_string()).chain(
        person_ids
            .iter()
            .map(|person_id| format!("{RETIRED_VOICEPRINT_PREFIX}{person_id}")),
    );
    for account in accounts {
        match entry(&account)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(error) => return Err(credential_error(error)),
        }
    }
    Ok(())
}

fn read_key(account: &str) -> AppResult<String> {
    entry(account)?.get_password().map_err(credential_error)
}

pub fn set_openai_key(value: &str) -> AppResult<bool> {
    let value = value.trim();
    if value.is_empty() {
        match entry(OPENAI_ACCOUNT)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(error) => return Err(credential_error(error)),
        }
        return Ok(false);
    }
    if !value.starts_with("sk-") {
        return Err(AppError::Validation(
            "OpenAI API keys normally begin with sk-".to_string(),
        ));
    }
    store_key(OPENAI_ACCOUNT, value)
}

fn store_key(account: &str, value: &str) -> AppResult<bool> {
    let credential = entry(account)?;
    credential.set_password(value).map_err(credential_error)?;

    let stored_value = credential.get_password().map_err(credential_error)?;
    if stored_value != value {
        return Err(AppError::Credential(
            "The operating system credential vault did not retain the secret".to_string(),
        ));
    }

    Ok(true)
}

fn entry(account: &str) -> AppResult<Entry> {
    Entry::new(SERVICE, account).map_err(credential_error)
}

fn credential_error(error: KeyringError) -> AppError {
    AppError::Credential(error.to_string())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use keyring::Entry;

    #[test]
    fn native_vault_round_trip() {
        let service = format!("app.listen.desktop.test.{}", uuid::Uuid::new_v4());
        let writer = Entry::new(&service, "round-trip").expect("create credential entry");

        writer
            .set_password("sk-test-not-a-real-key")
            .expect("store test credential");
        drop(writer);

        let reader = Entry::new(&service, "round-trip").expect("reopen credential entry");
        assert_eq!(
            reader.get_password().expect("read test credential"),
            "sk-test-not-a-real-key"
        );

        reader.delete_credential().expect("delete test credential");
    }
}
