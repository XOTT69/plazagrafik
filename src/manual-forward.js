import {format22,kyivDate,nextDate,validatedPeriods} from './schedule22.js';

// Manual fallback accepts ONLY a private, owner-forwarded text schedule
// with an explicit calendar date and a heading for subgroup 2.2.
// Ordinary posts in the public channel are never reposted.
const DATE_PATTERN=/\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/u;
const INTERVAL_PATTERN=/(?:з\s*)?([01]?\d|2[0-3]):([0-5]\d)\s*(?:до|[-–—])\s*([01]?\d|2[0-4]):([0-5]\d)/iu;
const NO_OUTAGE=/відключен(?:ь|ня|ням)?\s+(?:за\s+графіком\s+)?немає|без\s+відключень/iu;

function groupHeading(line) {
  const clean=String(line).trim().replace(/^[^а-яіїєґa-z0-9]+/iu,'');
  const match=/^(?:підгрупа|група|черга)\s+([1-6]\.[12])(?:\s+(?:відключення|відключень|графік))?\s*[:—–-]?\s*$/iu.exec(clean);
  return match?.[1] || null;
}

function parseDate(text) {
  const match=DATE_PATTERN.exec(text);
  if(!match)return null;
  const [day,month,year]=[Number(match[1]),Number(match[2]),Number(match[3])];
  const iso=[year,String(month).padStart(2,'0'),String(day).padStart(2,'0')].join('-');
  const sanity=new Date(Date.UTC(year,month-1,day)).toISOString().slice(0,10);
  return iso===sanity?iso:null;
}

export function parseForwardedGroup22(text,now=new Date()) {
  if(typeof text!=='string'||text.length>12000)return null;
  const date=parseDate(text);
  const today=kyivDate(now);
  // Old or far-future forwarded schedules must never overwrite current news.
  if(!date||![today,nextDate(today)].includes(date))return null;
  const lines=text.split(/\r?\n/u);
  const start=lines.findIndex(line=>groupHeading(line)==='2.2');
  if(start<0)return null;
  const periods=[];
  let noOutages=false;
  for(let i=start+1;i<lines.length;i++) {
    const line=lines[i].trim();
    if(groupHeading(line))break; // end at next subgroup
    if(NO_OUTAGE.test(line))noOutages=true;
    const match=INTERVAL_PATTERN.exec(line);
    if(!match)continue;
    const a=Number(match[1])*60+Number(match[2]);
    const b=Number(match[3])*60+Number(match[4]);
    periods.push([a,b]);
  }
  // A header by itself is not enough evidence of an empty daily schedule.
  if(!periods.length&&!noOutages)return null;
  if(periods.length&&noOutages)return null;
  const confirmed=validatedPeriods(periods);
  if(!confirmed)return null;
  return {
    date,
    periods:confirmed,
    text:format22(date,confirmed,{today}),
    source:'manual'
  };
}
