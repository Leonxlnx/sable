package io.github.leonxlnx.sable.mobile;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Files the agent handed over, on the phone.
 *
 * Paired securely, the bytes come over the sealed connection (the page asks for each chunk) and are
 * written here into the app's private storage (`stageBegin`, `stageWrite`), never anywhere another
 * app can reach. When they are all there, `stageFinish` reads the private file whole and compares it
 * with the SHA-256 the desktop recorded when the share completed: a file that differs is removed;
 * one that matches becomes a verified record (`files/verified/<id>.json` beside its file) and, unless
 * it is an app, is then copied to Downloads/Sable. Nothing is public and nothing says "downloaded"
 * before that check. Open hands on the verified private copy through this app's FileProvider.
 *
 * Over a pairing from before the secure channel, Android's DownloadManager fetches a plain HTTP link
 * into Downloads/Sable as before (`download`, `status`, `verify`); such a file never goes to the
 * installer.
 *
 * What goes to the installer is decided here, at the moment the intent is made (`dispatch`): by the
 * final MIME type, computed here from the file's canonical name (the page's word is never taken), and
 * only for a verified record, whose private copy is read whole again first. A name that is not
 * canonical (shared/file-name.ts: what the desktop sends) is refused before anything is decided by it.
 */
@CapacitorPlugin(name = "Files")
public class FilesPlugin extends Plugin {
    private static final String APK = "application/vnd.android.package-archive";
    /** The biggest file the secure channel brings (the desktop hashes at most 2 GiB). */
    private static final long MAX_SIZE = 2L * 1024 * 1024 * 1024;

    /** One thread for every private file's work: writes land in the order they were asked. */
    private final ExecutorService io = Executors.newSingleThreadExecutor();

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

    /** A canonical name (shared/file-name.ts): what this decides by, so it must be one already. */
    static boolean canonical(String name) {
        if (name == null || name.isEmpty()) return false;
        if (!Normalizer.isNormalized(name, Normalizer.Form.NFC)) return false;
        if (name.codePointCount(0, name.length()) > 120) return false;
        for (int i = 0; i < name.length(); ) {
            int c = name.codePointAt(i);
            int t = Character.getType(c);
            if (t == Character.CONTROL || t == Character.FORMAT) return false;
            if ("\\/:*?\"<>|".indexOf(c) >= 0) return false;
            i += Character.charCount(c);
        }
        char first = name.charAt(0);
        char last = name.charAt(name.length() - 1);
        return !(Character.isWhitespace(first) || Character.isSpaceChar(first) || first == '.' || Character.isWhitespace(last) || Character.isSpaceChar(last) || last == '.');
    }

    /** The final MIME type of a canonical name: the one thing that decides whether the installer is reached. */
    static String mimeFor(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        if (ext.equals("apk")) return APK;
        String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m != null ? m : "application/octet-stream";
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format(Locale.ROOT, "%02x", x));
        return s.toString();
    }

    private static String sha256Hex(String s) {
        try {
            return hex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The SHA-256 (hex) and size of a stream, read whole. */
    private static String[] digest(InputStream in) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 16];
            long size = 0;
            for (int n; (n = in.read(buf)) > 0; ) {
                md.update(buf, 0, n);
                size += n;
            }
            return new String[] { hex(md.digest()), String.valueOf(size) };
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }

    private static String[] digest(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            return digest(in);
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

    private static String readText(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) Math.min(f.length(), 1 << 16)];
            int n = 0;
            for (int r; n < b.length && (r = in.read(b, n, b.length - n)) > 0; ) n += r;
            return new String(b, 0, n, StandardCharsets.UTF_8);
        }
    }

    private static void writeText(File f, String text) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        try (OutputStream out = new FileOutputStream(tmp)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.flush();
        }
        if (!tmp.renameTo(f)) throw new IOException("rename");
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    // ── the secure channel's private files ──

    private File incoming() {
        File d = new File(getContext().getFilesDir(), "incoming");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    private File verified() {
        File d = new File(getContext().getFilesDir(), "verified");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    private static boolean idOk(String id) {
        return id != null && id.matches("[0-9a-f]{32}");
    }

    @PluginMethod
    public void stageBegin(PluginCall call) {
        String key = call.getString("key");
        String name = call.getString("name");
        String sha = call.getString("sha256");
        Long size = longOf(call, "size");
        if (key == null || !canonical(name) || sha == null || !sha.matches("[0-9a-fA-F]{64}") || size == null || size < 0 || size > MAX_SIZE) {
            call.reject("That file cannot be saved on this phone.");
            return;
        }
        io.execute(() -> {
            try {
                String want = sha.toLowerCase(Locale.ROOT);
                // The same file of the same share goes on from what is there; anything else starts over.
                String id = sha256Hex(key + "\u0000" + want + "\u0000" + size + "\u0000" + name).substring(0, 32);
                File meta = new File(incoming(), id + ".json");
                File part = new File(incoming(), id + ".part");
                long have = 0;
                if (meta.exists() && part.exists() && part.length() <= size) have = part.length();
                else {
                    JSONObject m = new JSONObject();
                    m.put("key", key);
                    m.put("name", name);
                    m.put("size", size);
                    m.put("sha256", want);
                    writeText(meta, m.toString());
                    try (OutputStream out = new FileOutputStream(part, false)) {
                        out.flush();
                    }
                }
                JSObject o = new JSObject();
                o.put("id", id);
                o.put("have", have);
                call.resolve(o);
            } catch (Exception e) {
                call.reject("That file cannot be saved on this phone.");
            }
        });
    }

    @PluginMethod
    public void stageWrite(PluginCall call) {
        String id = call.getString("id");
        String data = call.getString("data");
        Long offset = longOf(call, "offset");
        if (!idOk(id) || data == null || offset == null) {
            call.reject("The download stopped. Try again.");
            return;
        }
        io.execute(() -> {
            try {
                File meta = new File(incoming(), id + ".json");
                File part = new File(incoming(), id + ".part");
                if (!meta.exists() || !part.exists()) throw new IOException("gone");
                long size = new JSONObject(readText(meta)).getLong("size");
                // Strictly in order: a chunk is written only where the file ends.
                if (offset != part.length()) throw new IOException("order");
                byte[] b = Base64.decode(data, Base64.DEFAULT);
                if (part.length() + b.length > size) throw new IOException("too long");
                try (FileOutputStream out = new FileOutputStream(part, true)) {
                    out.write(b);
                    out.flush();
                }
                JSObject o = new JSObject();
                o.put("have", part.length());
                call.resolve(o);
            } catch (Exception e) {
                call.reject("The download stopped. Try again.");
            }
        });
    }

    @PluginMethod
    public void stageFinish(PluginCall call) {
        String id = call.getString("id");
        if (!idOk(id)) {
            call.reject("The file is no longer on this phone.");
            return;
        }
        io.execute(() -> {
            File meta = new File(incoming(), id + ".json");
            File part = new File(incoming(), id + ".part");
            try {
                JSONObject m = new JSONObject(readText(meta));
                String name = m.getString("name");
                String want = m.getString("sha256");
                long size = m.getLong("size");
                String[] got = digest(part);
                JSObject o = new JSObject();
                if (!canonical(name) || !same(got, want, size)) {
                    // Not the bytes the share recorded: removed, never opened, never public.
                    //noinspection ResultOfMethodCallIgnored
                    part.delete();
                    //noinspection ResultOfMethodCallIgnored
                    meta.delete();
                    o.put("ok", false);
                    call.resolve(o);
                    return;
                }
                File dir = new File(verified(), id);
                deleteTree(dir);
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                File file = new File(dir, name);
                if (!part.renameTo(file)) throw new IOException("move");
                JSONObject r = new JSONObject();
                r.put("name", name);
                r.put("sha256", want);
                r.put("size", size);
                r.put("mime", mimeFor(name));
                r.put("at", System.currentTimeMillis());
                // Verified: only now a copy where the person finds files (never an app: that is installed from here).
                if (!APK.equals(mimeFor(name))) r.put("published", publish(file, name, mimeFor(name)));
                writeText(new File(verified(), id + ".json"), r.toString());
                //noinspection ResultOfMethodCallIgnored
                meta.delete();
                o.put("ok", true);
                o.put("file", id);
                call.resolve(o);
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                //noinspection ResultOfMethodCallIgnored
                meta.delete();
                call.reject("The file is no longer on this phone.");
            }
        });
    }

    /** A copy of a verified file in Downloads/Sable (Android 10 on; before, the app's own Downloads folder). */
    private boolean publish(File file, String name, String mime) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = getContext().getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Sable");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return false;
                try (InputStream in = new FileInputStream(file); OutputStream out = cr.openOutputStream(uri)) {
                    if (out == null) throw new IOException("no stream");
                    byte[] buf = new byte[1 << 16];
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                } catch (IOException e) {
                    cr.delete(uri, null, null);
                    return false;
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(uri, done, null, null);
                return true;
            }
            File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) return false;
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            try (InputStream in = new FileInputStream(file); OutputStream out = new FileOutputStream(new File(dir, name))) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @PluginMethod
    public void stageDrop(PluginCall call) {
        String id = call.getString("id");
        if (!idOk(id)) {
            call.resolve();
            return;
        }
        io.execute(() -> {
            //noinspection ResultOfMethodCallIgnored
            new File(incoming(), id + ".part").delete();
            //noinspection ResultOfMethodCallIgnored
            new File(incoming(), id + ".json").delete();
            call.resolve();
        });
    }

    /** Every private file and record goes (the desktop was forgotten); copies in Downloads are the person's. */
    @PluginMethod
    public void forgetAll(PluginCall call) {
        io.execute(() -> {
            deleteTree(incoming());
            deleteTree(verified());
            call.resolve();
        });
    }

    // ── DownloadManager (a pairing from before the secure channel) ──

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String name = call.getString("name");
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            call.reject("That file has no link.");
            return;
        }
        if (!canonical(name)) {
            call.reject("That file cannot be saved on this phone.");
            return;
        }
        // Nothing fetched over plain HTTP ever goes to the installer, so nothing of that kind is fetched that way.
        if (APK.equals(mimeFor(name))) {
            call.reject("Pair again for a secure connection to install it");
            return;
        }
        try {
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            r.setTitle(name);
            String from = call.getString("from");
            if (from != null) r.setDescription(from);
            r.setMimeType(mimeFor(name));
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            // Downloads/Sable from Android 10 on (no permission needed there); before, the app's own folder.
            if (Build.VERSION.SDK_INT >= 29) r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "Sable/" + name);
            else r.setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, name);
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

    private String[] digestDownload(long id) throws IOException {
        try (ParcelFileDescriptor pfd = manager().openDownloadedFile(id); InputStream in = new FileInputStream(pfd.getFileDescriptor())) {
            return digest(in);
        }
    }

    @PluginMethod
    public void verify(PluginCall call) {
        long id = idOf(call);
        String want = call.getString("sha256");
        Long size = longOf(call, "size");
        // Off the plugins' thread: a big file takes a moment to read.
        new Thread(() -> {
            try {
                String[] got = digestDownload(id);
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

    /** The title DownloadManager keeps for a download (the canonical name it was saved under). */
    private String titleOf(long id) {
        try (Cursor c = manager().query(new DownloadManager.Query().setFilterById(id))) {
            if (c == null || !c.moveToFirst()) return null;
            return c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE));
        } catch (Exception e) {
            return null;
        }
    }

    // ── opening ──

    /**
     * Opens a verified record (`file`) or a legacy download (`id`). The MIME type is decided here,
     * never taken from the page; the installer is reached only for a verified record, from its private
     * copy, read whole again first.
     */
    @PluginMethod
    public void open(PluginCall call) {
        String file = call.getString("file");
        if (file != null) {
            openVerified(call, file);
            return;
        }
        long id = idOf(call);
        String want = call.getString("sha256");
        Long size = longOf(call, "size");
        new Thread(() -> {
            String title = titleOf(id);
            String dm = null;
            try {
                dm = manager().getMimeTypeForDownloadedFile(id);
            } catch (Exception ignored) {
                // not known
            }
            // By its own name, and by what DownloadManager says it is: either way, an app never opens from here.
            String mime = title != null && canonical(title) ? mimeFor(title) : "application/octet-stream";
            if (APK.equals(mime) || APK.equals(dm)) {
                call.reject("Pair again for a secure connection to install it");
                return;
            }
            if (want != null && !want.isEmpty()) {
                try {
                    if (!same(digestDownload(id), want, size)) {
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
            }
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
            dispatch(call, uri, mime, false);
        }).start();
    }

    private void openVerified(PluginCall call, String id) {
        if (!idOk(id)) {
            call.reject("The file is no longer on this phone.");
            return;
        }
        io.execute(() -> {
            try {
                File rec = new File(verified(), id + ".json");
                if (!rec.exists()) throw new IOException("gone");
                JSONObject r = new JSONObject(readText(rec));
                String name = r.getString("name");
                if (!canonical(name)) throw new IOException("name");
                File f = new File(new File(verified(), id), name);
                if (!f.exists()) throw new IOException("gone");
                String mime = mimeFor(name);
                if (APK.equals(mime) && !same(digest(f), r.getString("sha256"), r.getLong("size"))) {
                    deleteTree(new File(verified(), id));
                    //noinspection ResultOfMethodCallIgnored
                    rec.delete();
                    call.reject("It changed on this phone, so it was removed.");
                    return;
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
                dispatch(call, uri, mime, true);
            } catch (Exception e) {
                call.reject("The file is no longer on this phone.");
            }
        });
    }

    /** The one place an intent is made: the installer only for a verified record. */
    private void dispatch(PluginCall call, Uri uri, String mime, boolean verifiedRecord) {
        if (APK.equals(mime) && !verifiedRecord) {
            call.reject("Pair again for a secure connection to install it");
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, mime);
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
