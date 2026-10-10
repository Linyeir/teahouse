package io.github.linyeir.teahouse.localnetwork

import android.app.Activity
import android.os.Build
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
class LocalNetworkPlugin(activity: Activity) : Plugin(activity) {
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

    private fun grantedBefore17(invoke: Invoke) {
        val result = JSObject()
        result.put("localNetwork", "granted")
        invoke.resolve(result)
    }
}
