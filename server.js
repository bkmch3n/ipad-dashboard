'use strict';

var http  = require('http');
var https = require('https');
var fs    = require('fs');
var path  = require('path');
var urlMod = require('url');
var querystring = require('querystring');

var PORT     = parseInt(process.env.PORT    || '3000', 10);
var OWM_KEY  = process.env.OWM_KEY  || '733c75d480f41bd7e6114ea15197c1fa';
var LAT      = process.env.LAT      || '25.033';
var LON      = process.env.LON      || '121.5654';
var CAL_URL  = process.env.CAL_URL  || 'https://calendar.google.com/calendar/ical/998e9ce98f4561652eff3f0e219639e83f3864e9aa83bf14a12fe9f430c619b6%40group.calendar.google.com/private-e7703b84c1d27821bca2f376a69e44b8/basic.ics';
var CAL2_ID       = process.env.CAL2_ID || '7e6782b2f813aae415a8a2a49101ff55952b958e373f68872628a418c7ca9bea@group.calendar.google.com';
var CAL2_COLOR_ID = '4'; // Flamingo

// calendar2 reads via OAuth (not an API key) because the user is a guest on that
// calendar, not the owner — only OAuth-as-the-guest can read it without the owner
// having to change sharing settings or add a service account.
var GOOGLE_OAUTH_CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID     || '';
var GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
var GOOGLE_OAUTH_REFRESH_TOKEN = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '';

var CACHE_MS = 15 * 60 * 1000;

var weatherCache   = { data: null, ts: 0 };
var calendarCache  = { data: null, ts: 0 };
var calendarCache2 = { data: null, ts: 0 };
var oauthToken     = { accessToken: null, expiresAt: 0 };

// ── HTTP/S fetcher with redirect following ────────────────────────────────────

function fetchUrl(urlStr, cb, hops, headers) {
  hops = hops || 0;
  if (hops > 5) { cb(new Error('too many redirects')); return; }

  var parsed = urlMod.parse(urlStr);
  var mod    = parsed.protocol === 'https:' ? https : http;

  var req = mod.get(urlStr, { headers: headers || {} }, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      var loc = res.headers.location;
      if (loc.indexOf('//') === 0)        loc = parsed.protocol + loc;
      else if (loc.charAt(0) === '/')     loc = parsed.protocol + '//' + parsed.host + loc;
      res.resume();
      fetchUrl(loc, cb, hops + 1, headers);
      return;
    }
    var buf = [];
    res.setEncoding('utf8');
    res.on('data', function (c) { buf.push(c); });
    res.on('end',  function ()  { cb(null, buf.join('')); });
    res.on('error', cb);
  });

  req.on('error', cb);
  req.setTimeout(12000, function () { req.destroy(new Error('timeout')); });
}

// ── OAuth access token (refreshed from a stored refresh token) ───────────────

function refreshAccessToken(cb) {
  var body = querystring.stringify({
    client_id:     GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN,
    grant_type:    'refresh_token'
  });

  var options = urlMod.parse('https://oauth2.googleapis.com/token');
  options.method  = 'POST';
  options.headers = {
    'Content-Type':   'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body)
  };

  var req = https.request(options, function (res) {
    var buf = [];
    res.setEncoding('utf8');
    res.on('data', function (c) { buf.push(c); });
    res.on('end', function () {
      try {
        var data = JSON.parse(buf.join(''));
        if (data.error) { cb(new Error(data.error_description || data.error)); return; }
        oauthToken.accessToken = data.access_token;
        oauthToken.expiresAt   = Date.now() + (data.expires_in - 60) * 1000;
        cb(null, data.access_token);
      } catch (e) { cb(e); }
    });
    res.on('error', cb);
  });

  req.on('error', cb);
  req.setTimeout(12000, function () { req.destroy(new Error('timeout')); });
  req.write(body);
  req.end();
}

function getAccessToken(cb) {
  if (oauthToken.accessToken && Date.now() < oauthToken.expiresAt) {
    cb(null, oauthToken.accessToken);
    return;
  }
  refreshAccessToken(cb);
}

// ── Emoji stripper (iOS 9 / Safari 9 can't render many modern emoji) ─────────

function stripEmoji(str) {
  // iOS 9 can't render astral-plane emoji (U+1F000+) — they show as boxes.
  // Surrogate pairs cover all emoji above U+FFFF (🌿 🦢 🎉 etc.).
  return str
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    .replace(/️/g, '')
    .replace(/‍/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── ICS parser ────────────────────────────────────────────────────────────────

function unfoldICS(text) {
  return text.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

// Parse an ICS date/datetime string; tzOffset is hours east of UTC (e.g. +8 for Taipei)
function parseICSDate(str, tzOffset) {
  str = (str || '').trim();
  var isUTC = str.charAt(str.length - 1) === 'Z';
  var d = str.replace(/[TZ]/g, '');
  var y   = parseInt(d.substr(0, 4), 10);
  var mo  = parseInt(d.substr(4, 2), 10) - 1;
  var day = parseInt(d.substr(6, 2), 10);

  if (d.length <= 8) {
    // All-day date – store as midnight UTC
    return { date: new Date(Date.UTC(y, mo, day)), allDay: true };
  }

  var h  = parseInt(d.substr(8,  2), 10) || 0;
  var mi = parseInt(d.substr(10, 2), 10) || 0;
  var s  = parseInt(d.substr(12, 2), 10) || 0;

  var date;
  if (isUTC) {
    date = new Date(Date.UTC(y, mo, day, h, mi, s));
  } else {
    // Apply provided tzOffset (default 0 = treat as UTC)
    var offset = (tzOffset !== undefined && tzOffset !== null) ? tzOffset : 0;
    date = new Date(Date.UTC(y, mo, day, h - offset, mi, s));
  }
  return { date: date, allDay: false };
}

// Rough tz-offset lookup – only need to cover what Google Calendar might emit
// for a Taipei-based user.
function tzToOffset(tzid) {
  if (!tzid) return 0;
  tzid = tzid.toUpperCase();
  if (tzid.indexOf('TAIPEI') >= 0 || tzid.indexOf('HONG_KONG') >= 0 ||
      tzid.indexOf('SINGAPORE') >= 0 || tzid.indexOf('KUALA_LUMPUR') >= 0 ||
      tzid.indexOf('SHANGHAI') >= 0  || tzid.indexOf('BEIJING') >= 0 ||
      tzid.indexOf('CHONGQING') >= 0 || tzid.indexOf('URUMQI') >= 0 ||
      tzid.indexOf('IRKUTSK') >= 0   || tzid === 'CST') {
    return 8;
  }
  if (tzid.indexOf('TOKYO') >= 0 || tzid.indexOf('SEOUL') >= 0 ||
      tzid.indexOf('JST') >= 0) return 9;
  if (tzid.indexOf('KOLKATA') >= 0 || tzid.indexOf('CALCUTTA') >= 0) return 5.5;
  if (tzid.indexOf('UTC') >= 0 || tzid.indexOf('GMT') >= 0) return 0;
  return 0; // unknown → treat as UTC
}

function parseICS(text) {
  text = unfoldICS(text);
  var lines  = text.split('\n');
  var events = [];
  var cur    = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    if (line === 'BEGIN:VEVENT') {
      cur = { summary: '', rrule: null, exdates: [], recurrenceId: null, allDay: false };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur && cur.summary && cur.dtstart) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;

    var colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;

    var keyFull = line.substring(0, colonIdx);
    var value   = line.substring(colonIdx + 1);

    // Parse key params: "DTSTART;TZID=Asia/Taipei" → keyname="DTSTART", params={TZID:…}
    var semiIdx = keyFull.indexOf(';');
    var keyname = (semiIdx >= 0 ? keyFull.substring(0, semiIdx) : keyFull).toUpperCase();
    var params  = {};
    if (semiIdx >= 0) {
      keyFull.substring(semiIdx + 1).split(';').forEach(function (p) {
        var eq = p.indexOf('=');
        if (eq >= 0) params[p.substring(0, eq).toUpperCase()] = p.substring(eq + 1);
      });
    }

    var tzOffset = params.TZID ? tzToOffset(params.TZID) : 0;

    if (keyname === 'DTSTART') {
      var p1 = parseICSDate(value, tzOffset);
      cur.dtstart = p1.date;
      cur.allDay  = p1.allDay;
    } else if (keyname === 'DTEND') {
      var p2 = parseICSDate(value, tzOffset);
      cur.dtend = p2.date;
    } else if (keyname === 'SUMMARY') {
      cur.summary = stripEmoji(value.replace(/\\n/g, ' ').replace(/\\,/g, ',').replace(/\\\\/g, '\\').trim());
    } else if (keyname === 'RRULE') {
      cur.rrule = value;
    } else if (keyname === 'EXDATE') {
      // May be comma-separated list of dates
      value.split(',').forEach(function (ds) {
        var p3 = parseICSDate(ds, tzOffset);
        cur.exdates.push(p3.date.getTime());
      });
    } else if (keyname === 'RECURRENCE-ID') {
      var p4 = parseICSDate(value, tzOffset);
      cur.recurrenceId = p4.date;
    }
  }

  return events;
}

// ── RRULE expander ────────────────────────────────────────────────────────────

function expandRRule(ev, from, to) {
  var result = [];
  var parts  = {};
  ev.rrule.split(';').forEach(function (p) {
    var eq = p.indexOf('=');
    if (eq >= 0) parts[p.substring(0, eq)] = p.substring(eq + 1);
  });

  var freq     = parts.FREQ;
  if (!freq) return result;
  var interval = parseInt(parts.INTERVAL || '1', 10);
  var count    = parts.COUNT ? parseInt(parts.COUNT, 10) : null;
  var untilDate = parts.UNTIL ? parseICSDate(parts.UNTIL, 0).date : null;
  var maxDate  = untilDate && untilDate < to ? untilDate : to;

  var exSet = {};
  (ev.exdates || []).forEach(function (t) { exSet[t] = true; });

  var cur = new Date(ev.dtstart.getTime());
  var totalOccurrences = 0;
  var MAX_ITER = 3000; // safety cap

  while (cur <= maxDate && MAX_ITER-- > 0) {
    if (count !== null && totalOccurrences >= count) break;

    if (!exSet[cur.getTime()]) {
      totalOccurrences++;
      if (cur >= from) {
        result.push({ summary: ev.summary, dtstart: new Date(cur.getTime()), allDay: ev.allDay });
      }
    }

    var next = new Date(cur.getTime());
    if (freq === 'DAILY') {
      next.setUTCDate(next.getUTCDate() + interval);
    } else if (freq === 'WEEKLY') {
      next.setUTCDate(next.getUTCDate() + 7 * interval);
    } else if (freq === 'MONTHLY') {
      next.setUTCMonth(next.getUTCMonth() + interval);
    } else if (freq === 'YEARLY') {
      next.setUTCFullYear(next.getUTCFullYear() + interval);
    } else {
      break;
    }
    cur = next;
  }

  return result;
}

// ── Event expander: single + recurring ───────────────────────────────────────

function expandEvents(rawEvents, from, to) {
  var result = [];

  rawEvents.forEach(function (ev) {
    if (ev.rrule) {
      result = result.concat(expandRRule(ev, from, to));
    } else {
      // Single event (or modified recurrence instance)
      if (ev.dtstart >= from && ev.dtstart <= to) {
        result.push({ summary: ev.summary, dtstart: ev.dtstart, allDay: ev.allDay });
      }
    }
  });

  result.sort(function (a, b) { return a.dtstart.getTime() - b.dtstart.getTime(); });
  return result;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

var PUBLIC_DIR = path.join(__dirname, 'public');

function sendJSON(res, data) {
  var body = JSON.stringify(data);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendError(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain' });
  res.end(msg);
}

function serveWeather(res) {
  var now = Date.now();
  if (weatherCache.data && now - weatherCache.ts < CACHE_MS) {
    sendJSON(res, weatherCache.data);
    return;
  }

  var url = 'https://api.openweathermap.org/data/3.0/onecall' +
    '?lat=' + LAT + '&lon=' + LON +
    '&appid=' + OWM_KEY +
    '&units=metric&exclude=minutely,alerts';

  fetchUrl(url, function (err, body) {
    if (err) {
      if (weatherCache.data) { sendJSON(res, weatherCache.data); return; }
      sendError(res, 502, 'Weather unavailable: ' + err.message);
      return;
    }
    try {
      var data = JSON.parse(body);
      weatherCache = { data: data, ts: Date.now() };
      sendJSON(res, data);
    } catch (e) {
      sendError(res, 502, 'Weather parse error');
    }
  });
}

function serveCalendar(res, calUrl, cache) {
  var now = Date.now();
  if (cache.data && now - cache.ts < CACHE_MS) {
    sendJSON(res, cache.data);
    return;
  }

  fetchUrl(calUrl, function (err, body) {
    if (err) {
      if (cache.data) { sendJSON(res, cache.data); return; }
      sendError(res, 502, 'Calendar unavailable: ' + err.message);
      return;
    }
    try {
      var rawEvents = parseICS(body);
      // Window: yesterday → 90 days out (gives timezone slack)
      var from = new Date(Date.now() - 86400 * 1000);
      var to   = new Date(Date.now() + 90 * 86400 * 1000);

      var expanded = expandEvents(rawEvents, from, to);

      var result = expanded.slice(0, 20).map(function (ev) {
        return { summary: ev.summary, dtstart: ev.dtstart.getTime(), allDay: ev.allDay };
      });

      cache.data = result;
      cache.ts   = Date.now();
      sendJSON(res, result);
    } catch (e) {
      console.error('Calendar parse error:', e.message);
      sendError(res, 502, 'Calendar parse error');
    }
  });
}

// Google Calendar API date/dateTime → { ts, allDay }
function parseAPIStart(start) {
  if (start.date) {
    var parts = start.date.split('-');
    var y = parseInt(parts[0], 10), mo = parseInt(parts[1], 10) - 1, d = parseInt(parts[2], 10);
    return { ts: Date.UTC(y, mo, d), allDay: true };
  }
  return { ts: new Date(start.dateTime).getTime(), allDay: false };
}

// calendar2: fetched via Google Calendar API (not ICS) so we can filter by colorId —
// Google's public ICS export doesn't expose per-event color at all.
function serveCalendar2(res, cache) {
  var now = Date.now();
  if (cache.data && now - cache.ts < CACHE_MS) {
    sendJSON(res, cache.data);
    return;
  }

  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REFRESH_TOKEN) {
    if (cache.data) { sendJSON(res, cache.data); return; }
    sendError(res, 502, 'Calendar unavailable: OAuth not configured');
    return;
  }

  getAccessToken(function (tokErr, accessToken) {
    if (tokErr) {
      if (cache.data) { sendJSON(res, cache.data); return; }
      sendError(res, 502, 'Calendar unavailable: ' + tokErr.message);
      return;
    }

    var timeMin = new Date(Date.now() - 86400 * 1000).toISOString();
    var timeMax = new Date(Date.now() + 90 * 86400 * 1000).toISOString();
    var url = 'https://www.googleapis.com/calendar/v3/calendars/' +
      encodeURIComponent(CAL2_ID) + '/events' +
      '?timeMin=' + encodeURIComponent(timeMin) +
      '&timeMax=' + encodeURIComponent(timeMax) +
      '&singleEvents=true&orderBy=startTime&maxResults=50';

    fetchUrl(url, function (err, body) {
      if (err) {
        if (cache.data) { sendJSON(res, cache.data); return; }
        sendError(res, 502, 'Calendar unavailable: ' + err.message);
        return;
      }
      try {
        var parsed = JSON.parse(body);
        if (parsed.error) throw new Error(parsed.error.message || 'Google API error');

        var items = parsed.items || [];
        var result = items
          .filter(function (ev) {
            return ev.status !== 'cancelled' && ev.colorId === CAL2_COLOR_ID;
          })
          .map(function (ev) {
            var start = parseAPIStart(ev.start);
            return {
              summary: stripEmoji((ev.summary || '').trim()),
              dtstart: start.ts,
              allDay:  start.allDay
            };
          })
          .slice(0, 20);

        cache.data = result;
        cache.ts   = Date.now();
        sendJSON(res, result);
      } catch (e) {
        console.error('Calendar2 parse error:', e.message);
        sendError(res, 502, 'Calendar parse error');
      }
    }, 0, { 'Authorization': 'Bearer ' + accessToken });
  });
}

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.ico':  'image/x-icon'
};

var server = http.createServer(function (req, res) {
  var pathname = (req.url || '/').split('?')[0];

  if (pathname === '/api/weather') {
    serveWeather(res);
  } else if (pathname === '/api/calendar') {
    serveCalendar(res, CAL_URL, calendarCache);
  } else if (pathname === '/api/calendar2') {
    serveCalendar2(res, calendarCache2);
  } else {
    // Static file
    if (pathname === '/') pathname = '/index.html';
    var filePath = path.join(PUBLIC_DIR, pathname);

    // Prevent path traversal
    if (filePath.indexOf(PUBLIC_DIR) !== 0) {
      sendError(res, 403, 'Forbidden');
      return;
    }

    fs.readFile(filePath, function (err, data) {
      if (err) { sendError(res, 404, 'Not found'); return; }
      var ext  = path.extname(filePath);
      var mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  }
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('Dashboard listening on port ' + PORT);
});
