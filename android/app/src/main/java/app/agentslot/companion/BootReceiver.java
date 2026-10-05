package app.agentslot.companion;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** A reboot drops the socket; the pairing survives, so the service comes back by itself. */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        // Nothing saved = nothing to bring up. Get the active server from the profile list.
        if (new Profiles(context).active() == null) return;
        if (NotifyService.start(context)) return;
        // Boot-time FGS starts are type-restricted; when the platform says no, leave a
        // tappable nudge instead of a dead app the operator cannot explain.
        Notifier.ensureChannel(context, Notifier.DEFAULT_CHANNEL, "AgentSlot", "default", true, true);
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        nm.notify(Notifier.idFor("boot-reminder"), new Notification.Builder(context, Notifier.DEFAULT_CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("AgentSlot 通知服务没有自动起来")
            .setContentText("系统限制了开机自启，点这里打开一次即可")
            .setContentIntent(android.app.PendingIntent.getActivity(context, 98, open,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE))
            .setAutoCancel(true)
            .build());
    }
}