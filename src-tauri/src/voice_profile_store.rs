use std::{fs, path::PathBuf};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use parking_lot::Mutex;
use rand::{rngs::OsRng, RngCore};
use uuid::Uuid;

use crate::{
    credentials,
    error::{AppError, AppResult},
};

const FORMAT_VERSION: &[u8; 4] = b"LVP1";
const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;

pub struct VoiceProfileStore {
    directory: PathBuf,
    key: Mutex<Option<[u8; KEY_BYTES]>>,
}

impl VoiceProfileStore {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            key: Mutex::new(None),
        }
    }

    #[cfg(test)]
    fn with_key(directory: PathBuf, key: [u8; KEY_BYTES]) -> Self {
        Self {
            directory,
            key: Mutex::new(Some(key)),
        }
    }

    pub fn store(&self, person_id: &str, voiceprint: &str) -> AppResult<()> {
        let key = self.encryption_key()?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| AppError::Credential("Voice profile key is invalid".to_string()))?;
        let mut nonce_bytes = [0u8; NONCE_BYTES];
        OsRng.fill_bytes(&mut nonce_bytes);
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), voiceprint.as_bytes())
            .map_err(|_| AppError::Credential("Could not encrypt the voice profile".to_string()))?;
        let mut contents =
            Vec::with_capacity(FORMAT_VERSION.len() + NONCE_BYTES + ciphertext.len());
        contents.extend_from_slice(FORMAT_VERSION);
        contents.extend_from_slice(&nonce_bytes);
        contents.extend_from_slice(&ciphertext);

        fs::create_dir_all(&self.directory)?;
        let path = self.profile_path(person_id)?;
        let temporary = self
            .directory
            .join(format!("{}.tmp", Uuid::new_v4().simple()));
        fs::write(&temporary, contents)?;
        if path.exists() {
            fs::remove_file(&path)?;
        }
        if let Err(error) = fs::rename(&temporary, &path) {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        Ok(())
    }

    pub fn load(&self, person_id: &str) -> AppResult<Option<String>> {
        let path = self.profile_path(person_id)?;
        let contents = match fs::read(path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if contents.len() <= FORMAT_VERSION.len() + NONCE_BYTES
            || &contents[..FORMAT_VERSION.len()] != FORMAT_VERSION
        {
            return Err(AppError::Credential(
                "The local voice profile has an unsupported format".to_string(),
            ));
        }
        let key = self.encryption_key()?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| AppError::Credential("Voice profile key is invalid".to_string()))?;
        let nonce_start = FORMAT_VERSION.len();
        let ciphertext_start = nonce_start + NONCE_BYTES;
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&contents[nonce_start..ciphertext_start]),
                &contents[ciphertext_start..],
            )
            .map_err(|_| {
                AppError::Credential(
                    "The local voice profile could not be decrypted; delete and relearn it"
                        .to_string(),
                )
            })?;
        String::from_utf8(plaintext)
            .map(Some)
            .map_err(|_| AppError::Credential("The local voice profile is invalid".to_string()))
    }

    pub fn delete(&self, person_id: &str) -> AppResult<()> {
        let path = self.profile_path(person_id)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn encryption_key(&self) -> AppResult<[u8; KEY_BYTES]> {
        let mut cached = self.key.lock();
        if let Some(key) = *cached {
            return Ok(key);
        }
        let key = match credentials::voice_profile_master_key()? {
            Some(encoded) => decode_key(&encoded)?,
            None => {
                let mut generated = [0u8; KEY_BYTES];
                OsRng.fill_bytes(&mut generated);
                credentials::set_voice_profile_master_key(&STANDARD.encode(generated))?;
                generated
            }
        };
        *cached = Some(key);
        Ok(key)
    }

    fn profile_path(&self, person_id: &str) -> AppResult<PathBuf> {
        let id = Uuid::parse_str(person_id)
            .map_err(|_| AppError::Validation("Voice profile person ID is invalid".to_string()))?;
        Ok(self.directory.join(format!("{id}.lvp")))
    }
}

fn decode_key(encoded: &str) -> AppResult<[u8; KEY_BYTES]> {
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|_| AppError::Credential("Voice profile key is malformed".to_string()))?;
    decoded
        .try_into()
        .map_err(|_| AppError::Credential("Voice profile key has the wrong length".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_uuid_paths() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = VoiceProfileStore::new(directory.path().to_path_buf());
        assert!(store.profile_path("../escape").is_err());
    }

    #[test]
    fn encrypts_voiceprints_larger_than_the_windows_vault_limit() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = VoiceProfileStore::with_key(directory.path().to_path_buf(), [7u8; KEY_BYTES]);
        let person_id = Uuid::new_v4().to_string();
        let voiceprint = "precision-voiceprint-".repeat(1_000);

        store.store(&person_id, &voiceprint).expect("store profile");
        assert_eq!(
            store.load(&person_id).expect("load profile").as_deref(),
            Some(voiceprint.as_str())
        );

        store.delete(&person_id).expect("delete profile");
        assert!(store
            .load(&person_id)
            .expect("load deleted profile")
            .is_none());
    }
}
