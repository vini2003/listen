use std::{
    ffi::{c_char, c_void, CStr},
    panic::{catch_unwind, AssertUnwindSafe},
    sync::Arc,
};

use parking_lot::Mutex;

pub(crate) const SYSTEM_AUDIO_SAMPLE_RATE: i32 = 48_000;
pub(crate) const SYSTEM_AUDIO_CHANNELS: i32 = 2;
const ERROR_BUFFER_LENGTH: usize = 1_024;

type SampleCallback = unsafe extern "C" fn(*mut c_void, *const f32, usize);
type ErrorCallback = unsafe extern "C" fn(*mut c_void, *const c_char);

unsafe extern "C" {
    fn listen_system_audio_start(
        context: *mut c_void,
        samples: SampleCallback,
        error: ErrorCallback,
        error_buffer: *mut c_char,
        error_buffer_length: usize,
    ) -> *mut c_void;
    fn listen_system_audio_stop(
        capture: *mut c_void,
        error_buffer: *mut c_char,
        error_buffer_length: usize,
    ) -> bool;
}

struct CaptureContext {
    on_samples: Box<dyn Fn(&[f32]) + Send + Sync + 'static>,
    failure: Arc<Mutex<Option<String>>>,
}

pub(crate) struct MacSystemAudioCapture {
    capture: *mut c_void,
    context: *mut CaptureContext,
    failure: Arc<Mutex<Option<String>>>,
}

unsafe impl Send for MacSystemAudioCapture {}

impl MacSystemAudioCapture {
    pub(crate) fn start<F>(on_samples: F) -> Result<Self, String>
    where
        F: Fn(&[f32]) + Send + Sync + 'static,
    {
        let failure = Arc::new(Mutex::new(None));
        let context = Box::into_raw(Box::new(CaptureContext {
            on_samples: Box::new(on_samples),
            failure: Arc::clone(&failure),
        }));
        let mut error_buffer = [0 as c_char; ERROR_BUFFER_LENGTH];
        let capture = unsafe {
            listen_system_audio_start(
                context.cast(),
                receive_samples,
                receive_error,
                error_buffer.as_mut_ptr(),
                error_buffer.len(),
            )
        };
        if capture.is_null() {
            unsafe { drop(Box::from_raw(context)) };
            return Err(error_from_buffer(&error_buffer).unwrap_or_else(|| {
                "Could not start macOS system audio. Allow Listen under System Settings > Privacy & Security > Screen & System Audio Recording, then restart Listen."
                    .to_string()
            }));
        }
        Ok(Self {
            capture,
            context,
            failure,
        })
    }

    pub(crate) fn stop(self) -> Result<(), String> {
        let mut error_buffer = [0 as c_char; ERROR_BUFFER_LENGTH];
        let stopped = unsafe {
            listen_system_audio_stop(self.capture, error_buffer.as_mut_ptr(), error_buffer.len())
        };
        unsafe { drop(Box::from_raw(self.context)) };
        if let Some(error) = self.failure.lock().take() {
            return Err(error);
        }
        if stopped {
            Ok(())
        } else {
            Err(error_from_buffer(&error_buffer)
                .unwrap_or_else(|| "Could not stop macOS system audio".to_string()))
        }
    }
}

unsafe extern "C" fn receive_samples(context: *mut c_void, data: *const f32, length: usize) {
    if context.is_null() || data.is_null() || length == 0 {
        return;
    }
    let context = unsafe { &*(context.cast::<CaptureContext>()) };
    let samples = unsafe { std::slice::from_raw_parts(data, length) };
    if catch_unwind(AssertUnwindSafe(|| (context.on_samples)(samples))).is_err() {
        *context.failure.lock() = Some("macOS system audio processing failed".to_string());
    }
}

unsafe extern "C" fn receive_error(context: *mut c_void, message: *const c_char) {
    if context.is_null() {
        return;
    }
    let context = unsafe { &*(context.cast::<CaptureContext>()) };
    let message = if message.is_null() {
        "macOS system audio stopped unexpectedly".to_string()
    } else {
        unsafe { CStr::from_ptr(message) }
            .to_string_lossy()
            .into_owned()
    };
    *context.failure.lock() = Some(message);
}

fn error_from_buffer(buffer: &[c_char]) -> Option<String> {
    if buffer.first().copied().unwrap_or_default() == 0 {
        return None;
    }
    unsafe { CStr::from_ptr(buffer.as_ptr()) }
        .to_str()
        .ok()
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::{error_from_buffer, receive_samples, CaptureContext};
    use parking_lot::Mutex;
    use std::{ptr, sync::Arc};

    #[test]
    fn reads_native_callback_samples() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let callback_received = Arc::clone(&received);
        let context = Box::into_raw(Box::new(CaptureContext {
            on_samples: Box::new(move |samples| {
                callback_received.lock().extend_from_slice(samples)
            }),
            failure: Arc::new(Mutex::new(None)),
        }));
        let samples = [0.1, -0.2, 0.3, -0.4];
        unsafe { receive_samples(context.cast(), samples.as_ptr(), samples.len()) };
        unsafe { drop(Box::from_raw(context)) };
        assert_eq!(*received.lock(), samples);
    }

    #[test]
    fn ignores_empty_callback_samples() {
        unsafe { receive_samples(ptr::null_mut(), ptr::null(), 0) };
    }

    #[test]
    fn reads_error_buffer() {
        let mut buffer = [0_i8; 16];
        for (target, byte) in buffer.iter_mut().zip(b"denied\0") {
            *target = *byte as i8;
        }
        assert_eq!(error_from_buffer(&buffer).as_deref(), Some("denied"));
    }
}
