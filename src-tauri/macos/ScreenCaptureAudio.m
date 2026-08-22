#import <CoreAudio/CoreAudioTypes.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef void (*ListenSamplesCallback)(void *context, const float *samples, size_t length);
typedef void (*ListenErrorCallback)(void *context, const char *message);

static void ListenCopyMessage(char *buffer, size_t length, NSString *message) {
    if (buffer == NULL || length == 0) {
        return;
    }
    const char *utf8 = message.UTF8String;
    snprintf(buffer, length, "%s", utf8 != NULL ? utf8 : "Unknown macOS audio error");
}

@interface ListenSystemAudioCapture : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) dispatch_queue_t sampleQueue;
@property(nonatomic, assign) void *context;
@property(nonatomic, assign) ListenSamplesCallback samplesCallback;
@property(nonatomic, assign) ListenErrorCallback errorCallback;
@property(nonatomic, assign) BOOL reportedFormatError;
@end

@implementation ListenSystemAudioCapture

- (void)reportError:(NSString *)message {
    @synchronized(self) {
        if (self.context != NULL && self.errorCallback != NULL) {
            self.errorCallback(self.context, message.UTF8String);
        }
    }
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    (void)stream;
    [self reportError:[NSString stringWithFormat:@"macOS system audio stopped: %@",
                                                  error.localizedDescription]];
}

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
    (void)stream;
    if (type != SCStreamOutputTypeAudio || !CMSampleBufferDataIsReady(sampleBuffer)) {
        return;
    }

    CMAudioFormatDescriptionRef format =
        (CMAudioFormatDescriptionRef)CMSampleBufferGetFormatDescription(sampleBuffer);
    const AudioStreamBasicDescription *description =
        format != NULL ? CMAudioFormatDescriptionGetStreamBasicDescription(format) : NULL;
    if (description == NULL || description->mFormatID != kAudioFormatLinearPCM ||
        (description->mFormatFlags & kAudioFormatFlagIsFloat) == 0 ||
        description->mBitsPerChannel != 32) {
        if (!self.reportedFormatError) {
            self.reportedFormatError = YES;
            [self reportError:@"macOS provided an unsupported system audio sample format"];
        }
        return;
    }

    size_t listSize = 0;
    OSStatus status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer, &listSize, NULL, 0, kCFAllocatorDefault, kCFAllocatorDefault,
        kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, NULL);
    if (listSize == 0) {
        if (status != noErr) {
            [self reportError:[NSString stringWithFormat:@"Could not read macOS system audio (%d)",
                                                        (int)status]];
        }
        return;
    }

    AudioBufferList *buffers = malloc(listSize);
    if (buffers == NULL) {
        [self reportError:@"Could not allocate a macOS system audio buffer"];
        return;
    }
    CMBlockBufferRef blockBuffer = NULL;
    status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer, &listSize, buffers, listSize, kCFAllocatorDefault, kCFAllocatorDefault,
        kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, &blockBuffer);
    if (status != noErr) {
        free(buffers);
        [self reportError:[NSString stringWithFormat:@"Could not copy macOS system audio (%d)",
                                                    (int)status]];
        return;
    }

    size_t frameCount = (size_t)CMSampleBufferGetNumSamples(sampleBuffer);
    size_t channelCount = 0;
    for (UInt32 index = 0; index < buffers->mNumberBuffers; index++) {
        AudioBuffer buffer = buffers->mBuffers[index];
        size_t channels = MAX((size_t)buffer.mNumberChannels, (size_t)1);
        size_t availableFrames = (size_t)buffer.mDataByteSize / (sizeof(float) * channels);
        frameCount = MIN(frameCount, availableFrames);
        channelCount += channels;
    }
    if (frameCount == 0 || channelCount == 0 || frameCount > SIZE_MAX / channelCount) {
        if (blockBuffer != NULL) {
            CFRelease(blockBuffer);
        }
        free(buffers);
        return;
    }

    size_t sampleCount = frameCount * channelCount;
    float *interleaved = malloc(sampleCount * sizeof(float));
    if (interleaved == NULL) {
        if (blockBuffer != NULL) {
            CFRelease(blockBuffer);
        }
        free(buffers);
        [self reportError:@"Could not allocate converted macOS system audio"];
        return;
    }

    if (buffers->mNumberBuffers == 1) {
        memcpy(interleaved, buffers->mBuffers[0].mData, sampleCount * sizeof(float));
    } else {
        for (size_t frame = 0; frame < frameCount; frame++) {
            size_t outputChannel = 0;
            for (UInt32 index = 0; index < buffers->mNumberBuffers; index++) {
                AudioBuffer buffer = buffers->mBuffers[index];
                size_t channels = MAX((size_t)buffer.mNumberChannels, (size_t)1);
                const float *source = (const float *)buffer.mData;
                for (size_t channel = 0; channel < channels; channel++) {
                    interleaved[frame * channelCount + outputChannel++] =
                        source[frame * channels + channel];
                }
            }
        }
    }

    @synchronized(self) {
        if (self.context != NULL && self.samplesCallback != NULL) {
            self.samplesCallback(self.context, interleaved, sampleCount);
        }
    }
    free(interleaved);
    if (blockBuffer != NULL) {
        CFRelease(blockBuffer);
    }
    free(buffers);
}

@end

void *listen_system_audio_start(void *context, ListenSamplesCallback samplesCallback,
                                ListenErrorCallback errorCallback, char *errorBuffer,
                                size_t errorBufferLength) {
    if (@available(macOS 13.0, *)) {
        @autoreleasepool {
            __block SCShareableContent *content = nil;
            __block NSError *operationError = nil;
            dispatch_semaphore_t contentReady = dispatch_semaphore_create(0);
            [SCShareableContent
                getShareableContentExcludingDesktopWindows:NO
                                      onScreenWindowsOnly:NO
                                         completionHandler:^(SCShareableContent *result,
                                                             NSError *error) {
                                           content = result;
                                           operationError = error;
                                           dispatch_semaphore_signal(contentReady);
                                         }];
            dispatch_semaphore_wait(contentReady, DISPATCH_TIME_FOREVER);
            if (content == nil || operationError != nil) {
                NSString *message = operationError != nil
                    ? [NSString stringWithFormat:
                                    @"Could not access system audio: %@. Allow Listen under System "
                                     "Settings > Privacy & Security > Screen & System Audio Recording, "
                                     "then restart Listen.",
                                    operationError.localizedDescription]
                    : @"macOS did not provide shareable content for system audio";
                ListenCopyMessage(errorBuffer, errorBufferLength, message);
                return NULL;
            }

            SCDisplay *display = nil;
            CGDirectDisplayID mainDisplayID = CGMainDisplayID();
            for (SCDisplay *candidate in content.displays) {
                if (candidate.displayID == mainDisplayID) {
                    display = candidate;
                    break;
                }
            }
            if (display == nil) {
                display = content.displays.firstObject;
            }
            if (display == nil) {
                ListenCopyMessage(errorBuffer, errorBufferLength,
                                  @"macOS did not provide a display for system audio capture");
                return NULL;
            }

            NSMutableArray<SCRunningApplication *> *excludedApplications =
                [NSMutableArray array];
            pid_t currentProcess = getpid();
            for (SCRunningApplication *application in content.applications) {
                if (application.processID == currentProcess) {
                    [excludedApplications addObject:application];
                }
            }
            SCContentFilter *filter =
                [[SCContentFilter alloc] initWithDisplay:display
                                   excludingApplications:excludedApplications
                                        exceptingWindows:@[]];
            SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
            configuration.capturesAudio = YES;
            configuration.excludesCurrentProcessAudio = YES;
            configuration.sampleRate = 48000;
            configuration.channelCount = 2;

            ListenSystemAudioCapture *capture = [[ListenSystemAudioCapture alloc] init];
            capture.context = context;
            capture.samplesCallback = samplesCallback;
            capture.errorCallback = errorCallback;
            capture.sampleQueue =
                dispatch_queue_create("app.listen.desktop.system-audio", DISPATCH_QUEUE_SERIAL);
            capture.stream = [[SCStream alloc] initWithFilter:filter
                                               configuration:configuration
                                                    delegate:capture];

            NSError *addError = nil;
            BOOL added = [capture.stream addStreamOutput:capture
                                                    type:SCStreamOutputTypeAudio
                                      sampleHandlerQueue:capture.sampleQueue
                                                   error:&addError];
            if (!added) {
                ListenCopyMessage(errorBuffer, errorBufferLength,
                                  [NSString stringWithFormat:@"Could not attach macOS system audio: %@",
                                                             addError.localizedDescription]);
                capture.context = NULL;
                return NULL;
            }

            __block NSError *startError = nil;
            dispatch_semaphore_t started = dispatch_semaphore_create(0);
            [capture.stream startCaptureWithCompletionHandler:^(NSError *error) {
              startError = error;
              dispatch_semaphore_signal(started);
            }];
            dispatch_semaphore_wait(started, DISPATCH_TIME_FOREVER);
            if (startError != nil) {
                ListenCopyMessage(
                    errorBuffer, errorBufferLength,
                    [NSString stringWithFormat:
                                  @"Could not start macOS system audio: %@. Check Screen & System "
                                   "Audio Recording permission in System Settings.",
                                  startError.localizedDescription]);
                @synchronized(capture) {
                    capture.context = NULL;
                    capture.samplesCallback = NULL;
                    capture.errorCallback = NULL;
                }
                return NULL;
            }
            return (__bridge_retained void *)capture;
        }
    }
    ListenCopyMessage(errorBuffer, errorBufferLength,
                      @"System audio capture requires macOS 13 or newer");
    return NULL;
}

bool listen_system_audio_stop(void *handle, char *errorBuffer, size_t errorBufferLength) {
    if (handle == NULL) {
        ListenCopyMessage(errorBuffer, errorBufferLength,
                          @"The macOS system audio stream is not running");
        return false;
    }
    @autoreleasepool {
        ListenSystemAudioCapture *capture = (__bridge_transfer ListenSystemAudioCapture *)handle;
        __block NSError *stopError = nil;
        dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
        [capture.stream stopCaptureWithCompletionHandler:^(NSError *error) {
          stopError = error;
          dispatch_semaphore_signal(stopped);
        }];
        dispatch_semaphore_wait(stopped, DISPATCH_TIME_FOREVER);
        @synchronized(capture) {
            capture.context = NULL;
            capture.samplesCallback = NULL;
            capture.errorCallback = NULL;
        }
        capture.stream = nil;
        if (stopError != nil) {
            ListenCopyMessage(errorBuffer, errorBufferLength,
                              [NSString stringWithFormat:@"Could not stop macOS system audio: %@",
                                                         stopError.localizedDescription]);
            return false;
        }
        return true;
    }
}
