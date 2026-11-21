package io.github.leonxlnx.sable.mobile;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
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
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Files the agent handed over, on the phone.
 *
 * Paired securely, the bytes come over the sealed connection (the page asks for each chunk) and are
 * written here into the app's private storage (`stageBegin`, `stageWrite`), never anywhere another
 * app can reach. When they are all there, `stageFinish` reads the private file whole and compares it
 * with the SHA-256 the desktop recorded when the share completed: a file that differs is removed;
 * one that matches becomes a verified record (`files/verified/<id>.json` beside its file, named by
 * its id: `<id>.file`, so no name can be too long for the file system) and, unless it is an app, is
 * then copied to Downloads/Sable under its name cut to Android's byte budget, the extension kept.
 * Nothing is public and nothing says "downloaded" before that check. The record says where its copy
 * stands at every step ("pending" with the entry's uri before the bytes go, then true or false), so
 * a start after Android stopped the app in the middle finds the verified file done (`stageBegin`)
 * and finishes, or redoes, a copy cut off; it never downloads or publishes the file twice. Open hands
 * on the verified private copy through this app's FileProvider (its name given as the display name).
 * `discard` and `prune` remove private files no record of the page names; `forgetAll` removes every
 * private file and every copy and system download Sable made, and fails when anything is left.
 *
 * Over a pairing from before the secure channel nothing is downloaded any more (`download` refuses);
 * what an older build downloaded with DownloadManager still opens (`status`, `verify`, `open` by id)
 * and never goes to the installer.
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

    /** Bytes of a name in UTF-8 (Android's file names are at most 255 of them). */
    private static int utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8).length;
    }

    /**
     * A canonical name cut to fit a file name: at most 240 bytes of UTF-8 (room for the " (1)" that
     * MediaStore adds to a name already there), the extension kept, cut between characters.
     */
    static String displayName(String name) {
        final int budget = 240;
        if (utf8(name) <= budget) return name;
        int dot = name.lastIndexOf('.');
        String ext = dot > 0 && name.length() - dot <= 16 ? name.substring(dot) : "";
        String base = ext.isEmpty() ? name : name.substring(0, dot);
        int room = budget - utf8(ext);
        StringBuilder b = new StringBuilder();
        int used = 0;
        for (int i = 0; i < base.length(); ) {
            int c = base.codePointAt(i);
            int n = utf8(new String(Character.toChars(c)));
            if (used + n > room) break;
            b.appendCodePoint(c);
            used += n;
            i += Character.charCount(c);
        }
        String out = b.toString().replaceAll("[\s.]+$", "");
        return (out.isEmpty() ? "file" : out) + ext;
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

    /** Deletes a file or a folder with everything in it; true when nothing of it is left. */
    private static boolean deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
        return !f.exists();
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

    /** A verified record's private file: by its id (`<id>.file`), or where an older build put it (`<id>/<name>`). */
    private File verifiedFile(String id, String name) {
        File byId = new File(verified(), id + ".file");
        if (byId.exists()) return byId;
        File old = new File(new File(verified(), id), name);
        return old.exists() ? old : byId;
    }

    /** A verified record's private file and record go (not its copy in Downloads); true when nothing of it is left. */
    private boolean dropVerified(String id) {
        boolean ok = deleteTree(new File(verified(), id + ".file"));
        ok &= deleteTree(new File(verified(), id));
        ok &= deleteTree(new File(verified(), id + ".json"));
        return ok;
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
                // Verified before (Android stopped the app after the check, before the page wrote it down): done, never fetched again; a copy cut off is finished.
                File rec = new File(verified(), id + ".json");
                if (rec.exists()) {
                    JSONObject r = new JSONObject(readText(rec));
                    File f = verifiedFile(id, name);
                    if (name.equals(r.optString("name")) && want.equalsIgnoreCase(r.optString("sha256")) && r.optLong("size", -1) == size && f.exists() && f.length() == size) {
                        JSObject o = new JSObject();
                        o.put("id", id);
                        o.put("have", size);
                        o.put("file", id);
                        if (!APK.equals(mimeFor(name))) {
                            Object pub = r.opt("published");
                            o.put("published", Boolean.TRUE.equals(pub) || (!Boolean.FALSE.equals(pub) && publish(rec, r, f, name, mimeFor(name))));
                        }
                        call.resolve(o);
                        return;
                    }
                    dropVerified(id);
                }
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
                dropVerified(id);
                // By its id: no name, however long in bytes, can make this move fail.
                File file = new File(verified(), id + ".file");
                if (!part.renameTo(file)) throw new IOException("move");
                JSONObject r = new JSONObject();
                r.put("name", name);
                r.put("sha256", want);
                r.put("size", size);
                r.put("mime", mimeFor(name));
                r.put("at", System.currentTimeMillis());
                boolean app = APK.equals(mimeFor(name));
                // The record first (verified, its copy still to make), then the copy: a stop in between is finished at the next start.
                if (!app) r.put("published", "pending");
                File rec = new File(verified(), id + ".json");
                writeText(rec, r.toString());
                //noinspection ResultOfMethodCallIgnored
                meta.delete();
                o.put("ok", true);
                o.put("file", id);
                // Verified: only now a copy where the person finds files (never an app: that is installed from here).
                if (!app) o.put("published", publish(rec, r, file, name, mimeFor(name)));
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

    /**
     * A copy of a verified file in Downloads/Sable (Android 10 on; before, the app's own Downloads
     * folder), under its name cut to the byte budget. The record says where it stands at each step:
     * the entry's uri with "pending" before the bytes go (a copy half made by a start Android cut off
     * is removed and made again), true once it is there, false when it could not be made (said on the
     * row). True when the copy is there.
     */
    private boolean publish(File rec, JSONObject r, File file, String name, String mime) {
        String display = displayName(name);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = getContext().getContentResolver();
                String half = r.optString("uri", "");
                if (!half.isEmpty()) {
                    try {
                        cr.delete(Uri.parse(half), null, null);
                    } catch (Exception ignored) {
                        // gone already
                    }
                    r.remove("uri");
                }
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, display);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Sable");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return published(rec, r, false);
                r.put("uri", uri.toString());
                r.put("published", "pending");
                writeText(rec, r.toString());
                try (InputStream in = new FileInputStream(file); OutputStream out = cr.openOutputStream(uri)) {
                    if (out == null) throw new IOException("no stream");
                    byte[] buf = new byte[1 << 16];
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                } catch (IOException e) {
                    cr.delete(uri, null, null);
                    r.remove("uri");
                    return published(rec, r, false);
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                if (cr.update(uri, done, null, null) < 1) {
                    cr.delete(uri, null, null);
                    r.remove("uri");
                    return published(rec, r, false);
                }
                return published(rec, r, true);
            }
            File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) return published(rec, r, false);
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            try (InputStream in = new FileInputStream(file); OutputStream out = new FileOutputStream(new File(dir, display))) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            return published(rec, r, true);
        } catch (Exception e) {
            return published(rec, r, false);
        }
    }

    /** Writes where a record's copy stands; returns it. */
    private static boolean published(File rec, JSONObject r, boolean ok) {
        try {
            r.put("published", ok);
            writeText(rec, r.toString());
        } catch (Exception ignored) {
            // the next start reads "pending" and makes it again
        }
        return ok;
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

    /**
     * Everything Sable kept for the desktop goes (it was forgotten, or replaced by another computer):
     * every private file and record, every copy it put in Downloads/Sable (found in MediaStore by its
     * place and this app as owner, half-made ones included, whatever the page recorded) and every
     * system download an older build made. Read again after: anything left fails it, so the page
     * keeps its mark and tries again at the next start.
     */
    @PluginMethod
    public void forgetAll(PluginCall call) {
        io.execute(() -> {
            boolean ok = deleteTree(incoming());
            ok &= deleteTree(verified());
            ok &= unpublishAll();
            ok &= removeSystemDownloads();
            if (ok) call.resolve();
            else call.reject("Some files could not be removed.");
        });
    }

    /** The copies Sable made in Downloads/Sable, by MediaStore (Android 10 on) or in its own Downloads folder before; true when none is left. */
    private boolean unpublishAll() {
        if (Build.VERSION.SDK_INT < 29) {
            File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            return dir == null || deleteTree(dir);
        }
        ContentResolver cr = getContext().getContentResolver();
        Uri col = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        try {
            for (long id : ownCopies(cr, col)) cr.delete(ContentUris.withAppendedId(col, id), null, null);
            return ownCopies(cr, col).isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    /** The entries in Downloads/Sable this app owns (pending and trashed ones too). */
    private List<Long> ownCopies(ContentResolver cr, Uri col) {
        List<Long> ids = new ArrayList<>();
        String sel = MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ? AND " + MediaStore.MediaColumns.OWNER_PACKAGE_NAME + " = ?";
        String[] args = { Environment.DIRECTORY_DOWNLOADS + "/Sable/%", getContext().getPackageName() };
        String[] cols = { MediaStore.MediaColumns._ID };
        Cursor c;
        if (Build.VERSION.SDK_INT >= 30) {
            Bundle q = new Bundle();
            q.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, sel);
            q.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args);
            q.putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_INCLUDE);
            q.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_INCLUDE);
            c = cr.query(col, cols, q, null);
        } else {
            //noinspection deprecation
            c = cr.query(MediaStore.setIncludePending(col), cols, sel, args, null);
        }
        if (c == null) return ids;
        try {
            while (c.moveToNext()) ids.add(c.getLong(0));
        } finally {
            c.close();
        }
        return ids;
    }

    /** Every download this app asked DownloadManager for (an older build's plain ones), with their files; true when none is left. */
    private boolean removeSystemDownloads() {
        try {
            long[] ids = systemDownloads();
            if (ids.length > 0) manager().remove(ids);
            return systemDownloads().length == 0;
        } catch (Exception e) {
            return false;
        }
    }

    private long[] systemDownloads() {
        List<Long> ids = new ArrayList<>();
        try (Cursor c = manager().query(new DownloadManager.Query())) {
            if (c != null) while (c.moveToNext()) ids.add(c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_ID)));
        }
        long[] out = new long[ids.size()];
        for (int i = 0; i < out.length; i++) out[i] = ids.get(i);
        return out;
    }

    /** A verified private copy and its record go: the page let go of its entry (its copy in Downloads stays). */
    @PluginMethod
    public void discard(PluginCall call) {
        String id = call.getString("file");
        if (!idOk(id)) {
            call.resolve();
            return;
        }
        io.execute(() -> {
            if (dropVerified(id)) call.resolve();
            else call.reject("That file could not be removed.");
        });
    }

    /** Every private file and record whose id the page does not name goes (at start: entries let go, records Android cut off). */
    @PluginMethod
    public void prune(PluginCall call) {
        JSONArray list = call.getData().optJSONArray("keep");
        Set<String> keep = new HashSet<>();
        if (list != null) for (int i = 0; i < list.length(); i++) keep.add(list.optString(i));
        io.execute(() -> {
            for (File dir : new File[] { incoming(), verified() }) {
                File[] kids = dir.listFiles();
                if (kids == null) continue;
                for (File k : kids) {
                    String n = k.getName();
                    int dot = n.indexOf('.');
                    String id = dot > 0 ? n.substring(0, dot) : n;
                    if (!keep.contains(id)) deleteTree(k);
                }
            }
            call.resolve();
        });
    }

    // ── DownloadManager (a pairing from before the secure channel) ──

    /**
     * Nothing is fetched over plain HTTP any more: DownloadManager would publish it, and post its
     * notification, before anything could check bytes whose digest came the same plain way. A
     * pairing from before the secure channel pairs again to download.
     */
    @PluginMethod
    public void download(PluginCall call) {
        call.reject("Pair again to download it");
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
                File f = verifiedFile(id, name);
                if (!f.exists()) throw new IOException("gone");
                String mime = mimeFor(name);
                if (APK.equals(mime) && !same(digest(f), r.getString("sha256"), r.getLong("size"))) {
                    dropVerified(id);
                    call.reject("It changed on this phone, so it was removed.");
                    return;
                }
                // The file is named by its id here: the app that opens it is told its own name.
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f, displayName(name));
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
