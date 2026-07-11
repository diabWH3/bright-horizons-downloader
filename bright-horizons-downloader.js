// axios    - makes HTTP requests to the Bright Horizons API and to Google Cloud Storage
// moment   - parses/formats dates (event timestamps, filename dates, CLI date args)
// piexifjs - reads/writes EXIF metadata (date taken, artist, description) inside JPEGs
// file-type- inspects raw bytes of a buffer to figure out what kind of file it is (png/jpeg/etc)
// sharp    - image processing library, used here only to convert PNG -> JPEG
// fs       - Node's filesystem module, used to write downloaded photos to disk
const axios = require('axios'),
  moment = require('moment'),
  piexif = require('piexifjs'),
  FileType = require('file-type'),
  sharp = require('sharp'),
  fs = require('fs');

// Safety nets: if something throws/rejects in a way that isn't caught elsewhere,
// print it clearly instead of the script just going silent or exiting with no explanation.
process.on('unhandledRejection', (err) => {
  console.error('! Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('! Uncaught exception:', err);
});

// Top-level async IIFE (Immediately Invoked Function Expression) so we can use
// "await" at the top level of the script without wrapping everything in a named function.
(async () => {
  /* Process arguments
		0 - node.exe filepath
		1 - downloader.js filepath
		2 - startDate
		3 - period (day, week, month, etc)
		4 - session cookie id
  */
  const startDate = moment(process.argv[2]);
  // endOf(process.argv[3]) rounds forward to the end of the given period.
  // e.g. if startDate = 2026-06-01 and period = 'month', endDate becomes 2026-06-30 23:59:59.999
  const endDate = moment(startDate).endOf(process.argv[3]);
  
	console.log('   StartDate: ' + moment(startDate).format('ddd MM/DD/YYYY @ hh:mm A'));
	console.log('   EndDate:   ' + moment(endDate).format('ddd MM/DD/YYYY @ hh:mm A'));
  
  // The session cookie authenticates every request to the Bright Horizons API below.
  // It's short/medium-lived - if requests start failing with 401/403 errors,
  // or if the API silently returns unexpected data, get a fresh cookie from the site.
  const cookie = process.argv[4];

  // Step 1: Ask Bright Horizons for all "events" (activities, notes, etc.) in the date range.
  // unix() converts the moment dates into Unix timestamps, which the API expects.
  let res = await axios.get(`https://mybrightday.brighthorizons.com/remote/v1/events?direction=range&earliest_event_time=${startDate.unix()}&latest_event_time=${endDate.unix()}&num_events=300&client=dashboard`, {headers: {'cookie': cookie}, timeout: 30000});
  const events = res.data.events;

  // We only care about "Activity" type events (these are the ones that carry photo/video attachments).
  // Sorted oldest-to-newest so downloaded files and their numbering come out in chronological order.
  const activities = events.filter(e => e.type === 'Activity').sort((a, b) => a.event_time - b.event_time);
  console.log(`${activities.length} media records found.`);
  let count = 0;

  // Make sure the destination folder exists before we try writing any files into it.
  // Without this, fs.writeFileSync below fails with ENOENT (folder not found) on every
  // attempt, and writeFile()'s retry loop - which only expects "file already exists"
  // errors - will retry forever without ever succeeding, silently freezing the script.
  fs.mkdirSync('photos', {recursive: true});


  // Step 2: For each activity, download every attachment (photo/video) it has.
  for (const activity of activities) {
    // Build the base filename from the activity's timestamp, e.g. "2026-06-01 - 093015"
    const fileName = moment(activity.event_time, 'X').format('YYYY-MM-DD - hhmmss');
    for (const attachment of activity.new_attachments) {
      // --- Sub-step 2a: ask Bright Horizons WHERE the file actually lives ---
      // This endpoint does NOT return the image itself. It returns a small JSON object
      // containing a "signed_url" - a temporary, pre-authenticated link to the real file,
      // hosted on Google Cloud Storage. (This tripped us up initially: the code used to
      // assume this response WAS the image data, causing "Cannot read properties of
      // undefined (reading 'mime')" errors when file-type tried to sniff a JSON blob.)
      //
      // A `timeout` is set on every request below so that if the server (or a rate limiter)
      // stops responding mid-run, axios throws an ECONNABORTED error after N seconds instead
      // of hanging forever with no output - which is what silent "freezes" usually turn out to be.
      let attachmentInfo = await axios.get(`https://mybrightday.brighthorizons.com/remote/v1/obj_attachment?obj=${activity.key}&key=${attachment.key}`, {
        headers: {'cookie': cookie},
        timeout: 30000
      });
      const signedUrl = attachmentInfo.data.signed_url;
      if (!signedUrl) {
        // Defensive check: if Bright Horizons changes its response shape again in the
        // future, we skip this one attachment and log it, instead of crashing the whole run.
        console.error(`  ! No signed_url returned for attachment ${attachment.key} (activity ${activity.key}). Skipping.`);
        continue;
      }

      // --- Sub-step 2b: fetch the actual file bytes from the signed URL ---
      // No cookie needed here - the signed_url has its own embedded, temporary credentials
      // (visible in its query string, e.g. X-Goog-Credential=...). These signed URLs
      // typically expire after a short window (often well under an hour), so this second
      // request needs to happen soon after the first - which it does here, back-to-back.
      let media = await axios.get(signedUrl, {responseType: 'arraybuffer', timeout: 30000});
      let data = media.data;

      // Inspect the raw bytes to figure out what kind of file this is (png, jpeg, mp4, etc.)
      // FileType.fromBuffer() returns undefined (not an error) if it can't identify the type -
      // e.g. if data is empty, corrupted, or not actually a recognizable file format.
      let dataType = await FileType.fromBuffer(data);
      if (!dataType) {
        console.error(`  ! Could not detect file type after fetching signed_url for attachment ${attachment.key} (activity ${activity.key}). Skipping.`);
        continue;
      }

      // PNGs get converted to JPEG (via sharp) so that EXIF metadata (date, comment, artist)
      // can be embedded below - EXIF only applies to JPEG, not PNG.
      if (dataType.mime === 'image/png') {
        data = await sharp(data).jpeg({quality: 100}).toBuffer();
        // Re-check the type after conversion, since `data` and its format have now changed.
        dataType = await FileType.fromBuffer(data);
      }

      // For any JPEG (original or just-converted from PNG), stamp in the activity's
      // date/time, "Artist" tag, and comment text (if any) as EXIF metadata.
      if (dataType.mime === 'image/jpeg') {
        data = modifyExif(data.toString('binary'), activity);
      }

      // Write the file to disk (photos\ subfolder), auto-numbering if the name is taken.
      const fn = writeFile(fileName, dataType.ext, data);
      console.log(`${++count}: ${fn} saved successfully.`);
    }
  }
})();

// Embeds EXIF metadata into a JPEG's binary data so photo apps (Google Photos, Windows
// Photos, etc.) show the correct date taken, sort correctly, and display any caption.
// `data` must be a binary string (see data.toString('binary') where this is called).
function modifyExif(data, activity) {
  let eventTime = moment(activity.event_time, 'X');
  const exifDateTime = eventTime.format('YYYY:MM:DD HH:mm:ss');

  // piexif.load() parses any existing EXIF block out of the JPEG binary into a JS object.
  const exifObj = piexif.load(data);

  // Set the "date taken" fields to match when the activity actually happened
  // (rather than whenever this script downloaded the file).
  exifObj.Exif[piexif.ExifIFD.DateTimeOriginal] = exifObj.Exif[piexif.ExifIFD.DateTimeDigitized] = exifObj['0th'][piexif.ImageIFD.DateTime] = exifDateTime;
  exifObj['0th'][piexif.ImageIFD.Artist] = 'Bright Horizons'; //Added line - downwitda 2/27/25
  
  // If the activity has a caption/comment from the teacher, embed it as the image description.
  if (activity.comment) {
    exifObj['0th'][piexif.ImageIFD.ImageDescription] = activity.comment.trim();
	console.log('-- '+activity.comment.trim()); //Added line - downwitda 2/27/25
  }
  
  // Re-serialize the modified EXIF object and splice it back into the JPEG binary.
  const exifBytes = piexif.dump(exifObj);
  const newBinary = piexif.insert(exifBytes, data);

  // Convert back from a binary string to a proper Buffer for writing to disk.
  return Buffer.from(newBinary, 'binary');
}

// Writes `data` to disk under photos\<fileName> <NN>.<ext>, auto-incrementing NN
// if a file with that name already exists - this is what allows multiple attachments
// from the same activity/timestamp to be saved side by side without overwriting each other,
// and also makes reruns of the script safe (it won't clobber files already downloaded).
function writeFile(fileName, ext, data) {
  let count = 1;
  while (true) {
    try {
      let fn = `photos\\${fileName} ${count < 10 ? 0 : ''}${count}.${ext}`; //Added 'photos' subfolder - downwitda 3/27/25
      // flag: 'wx' = write, but FAIL if the file already exists (rather than overwriting).
      // That failure is what triggers the catch block below to bump the count and retry
      // with the next number, e.g. "... 01.jpg" -> "... 02.jpg".
	  fs.writeFileSync(fn, data, {flag: 'wx'});
      return fn;
    } catch (err) {
      // Only "file already exists" errors are expected/retryable here. Any other error
      // (permissions, missing folder, disk full, etc.) should stop the script and be
      // reported - retrying forever on those just silently freezes the whole run.
      if (err.code !== 'EEXIST') {
        throw err;
      }
      count++;
    }
  }
}