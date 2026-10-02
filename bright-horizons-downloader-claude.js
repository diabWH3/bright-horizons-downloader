// Bright Horizons photo/video downloader
//
// Usage:  node bright-horizons-downloader-claude.js <startDate> <period> "<cookie>"
//   e.g.  node bright-horizons-downloader-claude.js 2026-09-01 month "session=abc123..."
//
//   startDate - any date moment can parse (YYYY-MM-DD recommended)
//   period    - day | week | month | year   (range runs from startDate to the end of that period)
//   cookie    - session cookie string copied from a logged-in browser session
//
// axios     - HTTP requests (Bright Horizons API + Google Cloud Storage)
// moment    - date parsing/formatting
// piexifjs  - read/write EXIF metadata in JPEGs
// file-type - detects the real file type from raw bytes (png/jpeg/mp4/...)
// sharp     - converts PNG -> JPEG so EXIF can be embedded
const axios = require('axios'),
  moment = require('moment'),
  piexif = require('piexifjs'),
  FileType = require('file-type'),
  sharp = require('sharp'),
  fs = require('fs'),
  path = require('path'),
  util = require('util');

// ---------- Configuration ----------
const API_BASE = 'https://mybrightday.brighthorizons.com/remote/v1';
const OUT_DIR = 'photos';
const MANIFEST_PATH = path.join(OUT_DIR, '.downloaded.json'); // remembers what's already been saved
const TIMEOUT_MS = 30000;
const MAX_EVENTS = 300;   // the API's per-request cap (see warning below if you hit it)
const MAX_ATTEMPTS = 3;   // tries per attachment before giving up on it
const RETRY_DELAY_MS = 3000;

// Error log lives next to this script (not the folder you ran node from) and is appended to
// across runs. Only errors are written to it (console.error output, including the failed-
// attachment summary); normal progress and warnings stay on the console only. If a run has
// no errors, nothing is written. Each run's errors are grouped under a timestamped header.
const LOG_PATH = path.join(__dirname, 'bright-horizons-downloader-log.txt');
let logHeaderWritten = false;

function appendLog(text) {
  try { fs.appendFileSync(LOG_PATH, text + '\n'); } catch (_) { /* never let logging break a run */ }
}

const originalError = console.error.bind(console);
console.error = (...args) => {
  originalError(...args);
  if (!logHeaderWritten) {
    logHeaderWritten = true;
    // The cookie is deliberately NOT logged since it's a credential.
    appendLog(`\n===== Run started ${runStart} | startDate=${process.argv[2]} period=${process.argv[3]} =====`);
  }
  appendLog(`${moment().format('YYYY-MM-DD HH:mm:ss')} ${util.format(...args)}`);
};
const runStart = moment().format('YYYY-MM-DD HH:mm:ss');
process.on('exit', (code) => {
  if (logHeaderWritten) appendLog(`===== Run finished ${moment().format('YYYY-MM-DD HH:mm:ss')} | exit code ${code} =====`);
});

// Thrown for problems that make continuing pointless (e.g. expired cookie).
class FatalError extends Error {}

// Last-resort safety net so nothing fails silently.
process.on('unhandledRejection', (err) => {
  console.error('! Unhandled rejection:', err instanceof Error ? err.message : err);
  process.exit(1);
});

main().catch((err) => {
  console.error(err instanceof FatalError ? `! ${err.message}` : err);
  process.exit(1);
});

async function main() {
  // ----- Arguments -----
  const [, , dateArg, periodArg, cookie] = process.argv;
  const startDate = moment(dateArg);
  if (!dateArg || !cookie || !startDate.isValid() || !moment.normalizeUnits(periodArg)) {
    throw new FatalError('Usage: node bright-horizons-downloader-claude.js <startDate> <day|week|month|year> "<cookie>"');
  }
  const endDate = moment(startDate).endOf(periodArg);
  console.log('   StartDate: ' + startDate.format('ddd MM/DD/YYYY @ hh:mm A'));
  console.log('   EndDate:   ' + endDate.format('ddd MM/DD/YYYY @ hh:mm A'));

  // Authenticated client for the Bright Horizons API. (The Google signed URLs further
  // down must NOT get this cookie, so they use plain axios instead.)
  const api = axios.create({ baseURL: API_BASE, headers: { cookie }, timeout: TIMEOUT_MS });

  // ----- Step 1: list events in the date range -----
  let events;
  try {
    const res = await api.get('/events', {
      params: {
        direction: 'range',
        earliest_event_time: startDate.unix(),
        latest_event_time: endDate.unix(),
        num_events: MAX_EVENTS,
        client: 'dashboard',
      },
    });
    events = res.data.events || [];
  } catch (err) {
    throw authAware(err, 'Could not fetch the event list');
  }
  if (events.length >= MAX_EVENTS) {
    console.warn(`! Received ${events.length} events, which is the API's limit - some may be missing. ` +
      'Re-run with a smaller period (e.g. week or day) to be safe.');
  }

  // Only "Activity" events carry photo/video attachments. Oldest first.
  const activities = events.filter((e) => e.type === 'Activity').sort((a, b) => a.event_time - b.event_time);
  console.log(`${activities.length} media records found.`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = loadManifest();
  const failures = [];
  let saved = 0, skipped = 0, position = 0;

  // Count what actually needs downloading this run (excludes items already in the manifest),
  // so the item numbers below run 001 of N ... N of N.
  const total = activities.reduce((sum, a) =>
    sum + (a.new_attachments || []).filter((att) => !manifest[`${a.key}:${att.key}`]).length, 0);
  const label = () => `${String(++position).padStart(3, '0')} of ${String(total).padStart(3, '0')}`;
  console.log(`${total} attachment(s) to download.`);

  // ----- Step 2: download every attachment -----
  for (const activity of activities) {
    const baseName = moment.unix(activity.event_time).format('YYYY-MM-DD - HHmmss');

    for (const attachment of activity.new_attachments || []) {
      const id = `${activity.key}:${attachment.key}`;
      if (manifest[id]) { skipped++; continue; } // already downloaded on a previous run

      const item = label(); // e.g. "007 of 042" - counts saved and failed items alike
      try {
        let data = await withRetry(() => downloadAttachment(api, activity, attachment));

        let type = await FileType.fromBuffer(data);
        if (!type) throw new Error('Could not detect file type (empty or corrupt download)');

        // PNG -> JPEG so EXIF can be embedded.
        if (type.mime === 'image/png') {
          data = await sharp(data).jpeg({ quality: 100 }).toBuffer();
          type = await FileType.fromBuffer(data);
        }

        if (type.mime === 'image/jpeg') data = modifyExif(data, activity);

        const fn = writeFile(baseName, type.ext, data, activity.event_time);
        manifest[id] = path.basename(fn);
        saveManifest(manifest);
        saved++;
        console.log(`${item}: ${fn} saved successfully.`);
      } catch (err) {
        if (err instanceof FatalError) throw err;
        let msg = describeError(err);
        // A 404 on an attachment Bright Horizons itself flags as unprocessed means the file
        // was never produced on their servers - retrying (or re-running) won't help.
        if (err.response && err.response.status === 404 && attachment.thumbnail_ready === false) {
          msg += ' - Bright Horizons marks this attachment as not processed (thumbnail_ready=false); the video file likely does not exist on their servers.';
        }
        console.error(`${item}: ! Failed: attachment ${attachment.key} (activity ${activity.key}, ${baseName}): ${msg}`);
        failures.push({ activity: activity.key, attachment: attachment.key, time: baseName, error: msg, info: attachment });
      }
    }
  }

  // ----- Summary -----
  console.log(`\nDone. ${saved} saved, ${skipped} already downloaded, ${failures.length} failed.`);
  if (failures.length) {
    console.error(`Failed attachments (${failures.length}) - re-run the same command to retry just these:`);
    for (const f of failures) {
      console.error(` - ${f.time}  activity=${f.activity}  attachment=${f.attachment}\n     ${f.error}\n     attachment info: ${JSON.stringify(f.info)}`);
    }
    process.exitCode = 1;
  }
}

// Asks the API where the file lives, then fetches it from the signed Google Cloud Storage URL.
// Both steps are done together so a retry always gets a fresh signed URL (they expire in ~5 min).
async function downloadAttachment(api, activity, attachment) {
  let signedUrl;
  try {
    const info = await api.get('/obj_attachment', { params: { obj: activity.key, key: attachment.key } });
    signedUrl = info.data.signed_url;
  } catch (err) {
    throw authAware(err, 'Could not get attachment info');
  }
  if (!signedUrl) throw new Error('API returned no signed_url');

  const media = await axios.get(signedUrl, { responseType: 'arraybuffer', timeout: TIMEOUT_MS });
  return Buffer.from(media.data);
}

// Retries transient problems: timeouts/network errors, 404 (file not ready yet), 429, and 5xx.
// Anything else (and FatalErrors) fails immediately.
async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response && err.response.status;
      const transient = err.response ? (status === 404 || status === 429 || status >= 500) : !!err.code;
      if (!transient || attempt >= MAX_ATTEMPTS) throw err;
      console.warn(`  ... ${describeError(err)} - retrying (${attempt}/${MAX_ATTEMPTS - 1})`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
}

// Turns 401/403 from the Bright Horizons API into a clear "get a new cookie" stop.
function authAware(err, context) {
  const status = err.response && err.response.status;
  if (status === 401 || status === 403) {
    return new FatalError(`${context}: HTTP ${status}. Your session cookie has probably expired - grab a fresh one and re-run.`);
  }
  return err;
}

// Short, readable error text. Avoids dumping axios's giant error object (and the signed URL).
function describeError(err) {
  if (!err.response) return `${err.code || err.name}: ${err.message}`;
  const { status, statusText, data } = err.response;
  let detail = '';
  try {
    const body = Buffer.isBuffer(data) ? data.toString('utf8') : typeof data === 'string' ? data : JSON.stringify(data);
    const code = body.match(/<Code>(.*?)<\/Code>/);
    const msg = body.match(/<Message>(.*?)<\/Message>/);
    detail = code ? ` [${code[1]}${msg ? ': ' + msg[1] : ''}]` : ` ${body.slice(0, 200)}`;
  } catch (_) { /* ignore body parsing problems */ }
  return `HTTP ${status} ${statusText}${detail}`;
}

// Embeds date taken, artist, and caption as EXIF so photo apps sort/label correctly.
// If EXIF can't be written for some reason, the original image is returned untouched
// (better to keep the photo without metadata than to lose it).
function modifyExif(buffer, activity) {
  try {
    const binary = buffer.toString('binary');
    const exifDateTime = moment.unix(activity.event_time).format('YYYY:MM:DD HH:mm:ss');
    const exifObj = piexif.load(binary);

    exifObj.Exif[piexif.ExifIFD.DateTimeOriginal] =
      exifObj.Exif[piexif.ExifIFD.DateTimeDigitized] =
      exifObj['0th'][piexif.ImageIFD.DateTime] = exifDateTime;
    exifObj['0th'][piexif.ImageIFD.Artist] = 'Bright Horizons';

    if (activity.comment && activity.comment.trim()) {
      const comment = activity.comment.trim();
      console.log('-- ' + comment);
      exifObj['0th'][piexif.ImageIFD.ImageDescription] = toAscii(comment);
    }
    return Buffer.from(piexif.insert(piexif.dump(exifObj), binary), 'binary');
  } catch (err) {
    console.warn(`  ! Could not write EXIF (${err.message}); saving without it.`);
    return buffer;
  }
}

// piexifjs can only store plain ASCII in text tags; curly quotes/emoji in teacher
// comments would otherwise make the whole EXIF write fail.
function toAscii(s) {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '');
}

// Writes to photos/<name> NN.<ext>, bumping NN if the name is taken ('wx' = never overwrite).
// Also sets the file's modified time to when the activity happened (handy for videos, which have no EXIF here).
function writeFile(baseName, ext, data, eventTime) {
  for (let n = 1; ; n++) {
    const fn = path.join(OUT_DIR, `${baseName} ${String(n).padStart(2, '0')}.${ext}`);
    try {
      fs.writeFileSync(fn, data, { flag: 'wx' });
      const when = new Date(eventTime * 1000);
      fs.utimesSync(fn, when, when);
      return fn;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err; // permissions, disk full, etc. should stop the run
    }
  }
}

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch (_) { return {}; }
}
function saveManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}
