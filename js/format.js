// Number formatting in metric or imperial units.
import { getLang } from './i18n.js';

let units = 'm';
export const setUnits = (u) => (units = u === 'ft' ? 'ft' : 'm');
export const getUnits = () => units;

const nf = (digits = 0) => new Intl.NumberFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });

export function elevation(m) {
  if (m == null || Number.isNaN(m)) return '–';
  return units === 'ft' ? `${nf().format(m * 3.28084)} ft` : `${nf().format(m)} m`;
}

export function distance(m) {
  if (m == null) return '–';
  if (units === 'ft') {
    const ft = m * 3.28084;
    return ft < 2640 ? `${nf().format(ft)} ft` : `${nf(1).format(ft / 5280)} mi`;
  }
  return m < 1000 ? `${nf().format(m)} m` : `${nf(m < 10000 ? 2 : 1).format(m / 1000)} km`;
}

export function speed(ms) {
  if (ms == null) return '–';
  return units === 'ft' ? `${nf().format(ms * 2.23694)} mph` : `${nf().format(ms * 3.6)} km/h`;
}

export const degrees = (d, digits = 0) => (d == null || Number.isNaN(d) ? '–' : `${nf(digits).format(d)}°`);

export function duration(s) {
  if (s == null) return '–';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  if (h) return `${h}:${String(m).padStart(2, '0')} h`;
  return m ? `${m}:${String(sec).padStart(2, '0')} min` : `${sec} s`;
}

export const area = (m2) => (units === 'ft' ? `${nf(1).format(m2 / 4046.86)} ac` : `${nf(1).format(m2 / 10000)} ha`);
export const count = (n) => nf().format(n);
export const time = (date) => date.toLocaleTimeString(getLang() === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
