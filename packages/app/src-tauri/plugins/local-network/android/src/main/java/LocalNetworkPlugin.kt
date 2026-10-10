package io.github.linyeir.teahouse.localnetwork

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** Android 17, the first version with ACCESS_LOCAL_NETWORK. */
private const val ANDROID_17 = 37

@TauriPlugin(
    permissions = [
        Permission(strings = ["android.permission.ACCESS_LOCAL_NETWORK"], alias = "localNetwork")
    ]
)
class LocalNetworkPlugin(private val activity: Activity) : Plugin(activity) {
    // Before Android 17 the INTERNET permission covers the local network. Asking for a
    // permission the system does not know would come back as denied.

    @Command
    override fun checkPermissions(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < ANDROID_17) grantedBefore17(invoke) else super.checkPermissions(invoke)
    }

    @Command
    override fun requestPermissions(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < ANDROID_17) grantedBefore17(invoke) else super.requestPermissions(invoke)
    }

    /** After the second refusal Android no longer asks; only the settings page can allow it. */
    @Command
    fun openAppSettings(invoke: Invoke) {
        val intent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", activity.packageName, null),
        )
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
        invoke.resolve()
    }

    private fun grantedBefore17(invoke: Invoke) {
        val result = JSObject()
        result.put("localNetwork", "granted")
        invoke.resolve(result)
    }
}
