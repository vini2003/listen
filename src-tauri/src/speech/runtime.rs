use parakeet_rs::{ort::environment::Environment, ExecutionConfig, ExecutionProvider};
use parking_lot::Mutex;

use crate::error::{AppError, AppResult};

/// ONNX Runtime allows one environment per process; every model shares it.
static ENVIRONMENT: Mutex<Option<Environment>> = Mutex::new(None);

/// Half the logical cores, capped at four. Measured on a 32-thread Ryzen 9:
/// four threads ran Parakeet 20% faster than all of them (less contention),
/// and capping keeps recording, playback and the UI responsive meanwhile.
pub fn thread_budget() -> usize {
    std::thread::available_parallelism()
        .map(|cores| cores.get() / 2)
        .unwrap_or(2)
        .clamp(1, 4)
}

pub fn environment() -> AppResult<Environment> {
    let mut environment = ENVIRONMENT.lock();
    if let Some(existing) = environment.as_ref() {
        return Ok(existing.clone());
    }
    let created = parakeet_rs::ort::init()
        .with_name("listen")
        .build()
        .map_err(|error| model_error("start the speech runtime", error))?;
    *environment = Some(created.clone());
    Ok(created)
}

pub fn execution_config() -> AppResult<ExecutionConfig> {
    Ok(ExecutionConfig::new()
        .with_environment(environment()?)
        .with_execution_provider(ExecutionProvider::Cpu)
        .with_intra_threads(thread_budget())
        .with_inter_threads(1))
}

pub fn model_error(action: &str, error: impl std::fmt::Display) -> AppError {
    AppError::Speech(format!("Could not {action}: {error}"))
}
