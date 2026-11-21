package io.github.leonxlnx.sable.mobile;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.webkit.MimeTypeMap;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * Files the agent handed over, downloaded inside the app: Android's DownloadManager fetches the
 * desktop's one-file link (`phone.fileLink`) into Downloads/Sable, the page reads its progress, and
 * Open hands the finished file to the app that opens its kind (an APK to the installer). The system
 * shows its own notification when a download is done. The bytes come over plain HTTP, so what arrived
 * is read whole and compared with the SHA-256 and size the desktop named over the connection: when
 * the download finishes (verify) and again right before Open hands it on; a file that differs is
 * removed and never opened.
 */
@CapacitorPlugin(name = "Files")
public class FilesPlugin extends Plugin {
    private DownloadManager manager() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    private static long idOf(PluginCall call) {
        try {
            return Long.parseLong(call.getString("id", "-1"));
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static String mimeFor(String name, String given) {
        if (given != null && !given.isEmpty()) return given;
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        if (ext.equals("apk")) return "application/vnd.android.package-archive";
        String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m != null ? m : "application/octet-stream";
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String name = call.getString("name");
        if (url == null || name == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            call.reject("That file has no link.");
            return;
        }
        String safe = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (safe.isEmpty() || safe.startsWith(".")) safe = "file" + safe;
        try {
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            r.setTitle(safe);
            String from = call.getString("from");
            if (from != null) r.setDescription(from);
            r.setMimeType(mimeFor(safe, call.getString("mime")));
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            // Downloads/Sable from Android 10 on (no permission needed there); before, the app's own folder.
            if (Build.VERSION.SDK_INT >= 29) r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "Sable/" + safe);
            else r.setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, safe);
            long id = manager().enqueue(r);
            JSObject o = new JSObject();
            o.put("id", String.valueOf(id));
            call.resolve(o);
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "The download could not start.");
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        long id = idOf(call);
        JSObject o = new JSObject();
        try (Cursor c = manager().query(new DownloadManager.Query().setFilterById(id))) {
            if (c == null || !c.moveToFirst()) {
                o.put("state", "gone");
                call.resolve(o);
                return;
            }
            int st = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            String state;
            if (st == DownloadManager.STATUS_SUCCESSFUL) state = "done";
            else if (st == DownloadManager.STATUS_FAILED) state = "failed";
            else if (st == DownloadManager.STATUS_PAUSED) state = "paused";
            else if (st == DownloadManager.STATUS_RUNNING) state = "running";
            else state = "pending";
            o.put("state", state);
            o.put("bytes", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)));
            o.put("total", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)));
            o.put("reason", c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)));
            call.resolve(o);
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "The download is not known.");
        }
    }

    /** The SHA-256 (hex) and size of a finished download, read whole. */
    private String[] digest(long id) throws IOException {
        try (ParcelFileDescriptor pfd = manager().openDownloadedFile(id); InputStream in = new FileInputStream(pfd.getFileDescriptor())) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 16];
            long size = 0;
            for (int n; (n = in.read(buf)) > 0; ) {
                md.update(buf, 0, n);
                size += n;
            }
            StringBuilder hex = new StringBuilder();
            for (byte b : md.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
            return new String[] { hex.toString(), String.valueOf(size) };
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }

    /** A number the page sent, as a long (a small one arrives as an Integer, which getLong does not take). */
    private static Long longOf(PluginCall call, String name) {
        Object v = call.getData().opt(name);
        return v instanceof Number ? ((Number) v).longValue() : null;
    }

    /** True when the file is what was named (sha256 in hex, and size when given). */
    private static boolean same(String[] got, String sha256, Long size) {
        return sha256 != null && sha256.equalsIgnoreCase(got[0]) && (size == null || size == Long.parseLong(got[1]));
    }

    @PluginMethod
    public void verify(PluginCall call) {
        long id = idOf(call);
        String want = call.getString("sha256");
        Long size = longOf(call, "size");
        // Off the plugins' thread: a big file takes a moment to read.
        new Thread(() -> {
            try {
                String[] got = digest(id);
                JSObject o = new JSObject();
                o.put("ok", same(got, want, size));
                o.put("sha256", got[0]);
                o.put("size", Long.parseLong(got[1]));
                call.resolve(o);
            } catch (Exception e) {
                call.reject("The file is no longer on this phone.");
            }
        }).start();
    }

    @PluginMethod
    public void open(PluginCall call) {
        String want = call.getString("sha256");
        if (want == null || want.isEmpty()) {
            openNow(call);
            return;
        }
        long id = idOf(call);
        Long size = longOf(call, "size");
        new Thread(() -> {
            try {
                if (!same(digest(id), want, size)) {
                    try {
                        manager().remove(id);
                    } catch (Exception ignored) {
                        // already gone
                    }
                    call.reject("It changed on this phone, so it was removed.");
                    return;
                }
            } catch (Exception e) {
                call.reject("The file is no longer on this phone.");
                return;
            }
            openNow(call);
        }).start();
    }

    private void openNow(PluginCall call) {
        long id = idOf(call);
        Uri uri;
        try {
            uri = manager().getUriForDownloadedFile(id);
        } catch (Exception e) {
            uri = null;
        }
        if (uri == null) {
            call.reject("The file is no longer on this phone.");
            return;
        }
        String mime = call.getString("mime");
        if (mime == null || mime.isEmpty()) mime = manager().getMimeTypeForDownloadedFile(id);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, mime != null ? mime : "application/octet-stream");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getActivity().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this phone opens this kind of file.");
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        long id = idOf(call);
        try {
            manager().remove(id);
        } catch (Exception e) {
            // already gone
        }
        call.resolve();
    }
}
