//! On Android, rustls-platform-verifier asks Android's TrustManager through JNI, which honours
//! the app's network security config (user CAs included). It needs the JavaVM and a context
//! before the first connection, and its Kotlin component in the APK (android/overlay.sh adds
//! it to the Gradle project). tao registers the VM and the activity with ndk-context.

use jni::objects::JObject;
use jni::{jni_sig, jni_str};

pub fn init_platform_verifier() -> Result<(), String> {
    let android = ndk_context::android_context();
    // SAFETY: tao stores the process's JavaVM and a global reference to the activity in
    // ndk-context before the app's setup runs, and both live as long as the process.
    let vm = unsafe { jni::JavaVM::from_raw(android.vm().cast()) };
    vm.attach_current_thread(|env| -> Result<(), jni::errors::Error> {
        let activity = unsafe { JObject::from_raw(env, android.context().cast()) };
        // The application context outlives any activity.
        let context = env
            .call_method(
                &activity,
                jni_str!("getApplicationContext"),
                jni_sig!("()Landroid/content/Context;"),
                &[],
            )?
            .l()?;
        rustls_platform_verifier::android::init_with_env(env, context)
    })
    .map_err(|err| format!("initializing the platform verifier: {err}"))
}
