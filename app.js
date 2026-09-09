'use strict';
process.env.PWD = process.cwd();

const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

// --- Config & Secret ---

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'default.config'), 'utf8'));

let secret = { rapidapi_key: '' };
try {
  secret = JSON.parse(fs.readFileSync(path.join(__dirname, 'secret'), 'utf8'));
} catch (_) {
  console.log('[warn] No secret file found — flight lookup disabled. Copy default.secret to secret and add your RapidAPI key.');
}

const DATA_DIR      = path.join(__dirname, config.data_dir);
const AIRPORTS_FILE = path.join(__dirname, config.airports_file);
const FLIGHTS_FILE  = path.join(__dirname, config.flights_file);
const AIRPORTS_URL  = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat';

// --- In-memory stores ---

let airports = {}; // IATA -> {name, city, country, lat, lon}
let flights  = [];

// --- Helpers ---

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; }
    else if (c === ',' && !inQuote) { fields.push(cur); cur = ''; }
    else { cur += c; }
  }
  fields.push(cur);
  return fields;
}

function parseAirports(dat) {
  const result = {};
  for (const line of dat.split('\n')) {
    if (!line.trim()) continue;
    const f = parseCSVLine(line);
    if (f.length < 8) continue;
    const iata = f[4].replace(/"/g, '').trim();
    if (!iata || iata === '\\N' || iata === '-') continue;
    result[iata] = {
      name:    f[1].replace(/"/g, '').trim(),
      city:    f[2].replace(/"/g, '').trim(),
      country: f[3].replace(/"/g, '').trim(),
      lat:     parseFloat(f[6]),
      lon:     parseFloat(f[7])
    };
  }
  return result;
}

function parseFlightsCSV(csv) {
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  return lines.slice(1).map((line, idx) => {
    if (!line.trim()) return null;
    const f = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (f[i] || '').trim(); });
    return {
      id:            idx + 1,
      date:          obj['date'] || '',
      from:          obj['from'] || '',
      to:            obj['to'] || '',
      flight_number: obj['flight_number'] || '',
      airline:       obj['airline'] || '',
      distance:      parseInt(obj['distance']) || 0,
      duration:      obj['duration'] || '',
      seat:          obj['seat'] || '',
      seat_type:     obj['seat_type'] || '',
      class:         obj['class'] || '',
      reason:        obj['reason'] || '',
      plane:         obj['plane'] || '',
      registration:  obj['registration'] || '',
      trip:          obj['trip'] || '',
      note:          obj['note'] || ''
    };
  }).filter(Boolean);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function saveFlights() {
  fs.writeFileSync(FLIGHTS_FILE, JSON.stringify(flights, null, 2));
}

function nextId() {
  return flights.reduce((max, f) => Math.max(max, f.id || 0), 0) + 1;
}

// --- AeroDataBox lookup ---

function lookupFlightAPI(flightNumber, date) {
  const fn = flightNumber.replace(/\s+/g, '').toUpperCase();
  const options = {
    hostname: 'aerodatabox.p.rapidapi.com',
    path: `/flights/number/${fn}/${date}`,
    method: 'GET',
    headers: {
      'x-rapidapi-key':  secret.rapidapi_key,
      'x-rapidapi-host': 'aerodatabox.p.rapidapi.com'
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!Array.isArray(json) || json.length === 0) return reject(new Error('Flight not found'));
          const f = json[0];
          const fromIata = f.departure?.airport?.iata || '';
          const toIata   = f.arrival?.airport?.iata   || '';

          let distance = Math.round(f.greatCircleDistance?.km || 0);
          if (!distance && airports[fromIata] && airports[toIata]) {
            const a = airports[fromIata], b = airports[toIata];
            distance = haversine(a.lat, a.lon, b.lat, b.lon);
          }

          let duration = '';
          const depTime = f.departure?.scheduledTime?.utc || f.departure?.scheduledTime?.local;
          const arrTime = f.arrival?.scheduledTime?.utc   || f.arrival?.scheduledTime?.local;
          if (depTime && arrTime) {
            const mins = Math.round((new Date(arrTime) - new Date(depTime)) / 60000);
            const h = Math.floor(Math.abs(mins) / 60);
            const m = Math.abs(mins) % 60;
            duration = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          }

          resolve({
            from:           fromIata,
            to:             toIata,
            airline:        f.airline?.name  || '',
            plane:          f.aircraft?.model || '',
            distance,
            duration,
            departure_time: f.departure?.scheduledTime?.local || '',
            arrival_time:   f.arrival?.scheduledTime?.local   || ''
          });
        } catch (e) {
          reject(new Error('Failed to parse API response: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// --- Startup ---

async function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(AIRPORTS_FILE)) {
    console.log('[init] Downloading airports.dat from OpenFlights...');
    try {
      const dat = await httpsGet(AIRPORTS_URL);
      fs.writeFileSync(AIRPORTS_FILE, dat);
      console.log('[init] airports.dat saved');
    } catch (e) {
      console.warn('[warn] Could not download airports.dat:', e.message);
    }
  }

  if (fs.existsSync(AIRPORTS_FILE)) {
    airports = parseAirports(fs.readFileSync(AIRPORTS_FILE, 'utf8'));
    console.log(`[init] Loaded ${Object.keys(airports).length} airports`);
  }

  if (fs.existsSync(FLIGHTS_FILE)) {
    flights = JSON.parse(fs.readFileSync(FLIGHTS_FILE, 'utf8'));
    console.log(`[init] Loaded ${flights.length} flights from ${config.flights_file}`);
  } else {
    const csvFile = path.join(__dirname, config.csv_backup);
    if (fs.existsSync(csvFile)) {
      console.log('[init] Importing flights from CSV backup...');
      flights = parseFlightsCSV(fs.readFileSync(csvFile, 'utf8'));
      // Fill in missing distances using airport coordinates
      flights.forEach(f => {
        if (!f.distance && airports[f.from] && airports[f.to]) {
          const a = airports[f.from], b = airports[f.to];
          f.distance = haversine(a.lat, a.lon, b.lat, b.lon);
        }
      });
      saveFlights();
      console.log(`[init] Imported and saved ${flights.length} flights`);
    } else {
      console.log('[init] No CSV backup found — starting with empty flight list');
    }
  }
}

// --- Express ---

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/flights', (_req, res) => {
  res.json(flights);
});

app.get('/api/airports', (_req, res) => {
  const used = new Set(flights.flatMap(f => [f.from, f.to]).filter(Boolean));
  const result = {};
  used.forEach(iata => { if (airports[iata]) result[iata] = airports[iata]; });
  res.json(result);
});

app.post('/api/flights/lookup', async (req, res) => {
  const { flight_number, date } = req.body;
  if (!flight_number || !date) return res.status(400).json({ error: 'flight_number and date required' });
  if (!secret.rapidapi_key) return res.status(503).json({ error: 'No RapidAPI key in secret file' });
  try {
    const result = await lookupFlightAPI(flight_number, date);
    res.json(result);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.post('/api/flights', (req, res) => {
  const f = req.body;
  if (!f.from || !f.to || !f.date) return res.status(400).json({ error: 'from, to, and date are required' });
  if (!f.distance && airports[f.from] && airports[f.to]) {
    const a = airports[f.from], b = airports[f.to];
    f.distance = haversine(a.lat, a.lon, b.lat, b.lon);
  }
  f.id = nextId();
  flights.unshift(f);
  saveFlights();
  res.json(f);
});

// --- Start ---

init().then(() => {
  app.listen(config.port, () => {
    console.log(`OpenFlights running at http://localhost:${config.port}`);
  });
}).catch(e => {
  console.error('[fatal]', e);
  process.exit(1);
});
