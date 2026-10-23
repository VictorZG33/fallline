// Sun position (after Vladimir Agafonkin's SunCalc, from Astronomical Algorithms).
const rad = Math.PI / 180;
const DAY_MS = 864e5;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = rad * 23.4397;

const toDays = (date) => date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;

function sunCoords(d) {
  const M = rad * (357.5291 + 0.98560028 * d);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  return {
    dec: Math.asin(Math.sin(L) * Math.sin(OBLIQUITY)),
    ra: Math.atan2(Math.sin(L) * Math.cos(OBLIQUITY), Math.cos(L)),
  };
}

// Azimuth in compass degrees (0 = north, 90 = east) and altitude in degrees.
export function sunPosition(date, lat, lng) {
  const d = toDays(date);
  const phi = rad * lat;
  const c = sunCoords(d);
  const H = rad * (280.16 + 360.9856235 * d) + rad * lng - c.ra;
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi));
  const alt = Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H));
  return { azimuth: (az / rad + 180 + 360) % 360, altitude: alt / rad };
}

// Sunrise and sunset on the local calendar day of `date`, found by stepping through it.
export function sunTimes(date, lat, lng) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const STEP = 5 * 60 * 1000;
  let rise = null;
  let set = null;
  let prev = sunPosition(start, lat, lng).altitude + 0.833;
  for (let t = start.valueOf() + STEP; t <= start.valueOf() + DAY_MS; t += STEP) {
    const cur = sunPosition(new Date(t), lat, lng).altitude + 0.833;
    if (prev < 0 && cur >= 0 && !rise) rise = new Date(t - (STEP * cur) / (cur - prev));
    if (prev >= 0 && cur < 0) set = new Date(t - (STEP * cur) / (cur - prev));
    prev = cur;
  }
  return { rise, set, start };
}
