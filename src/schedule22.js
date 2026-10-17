// Only verified DTEK daily "fact" schedules from XOTT69/dtek.
// Never parse/repost Telegram posts: this prevents loops on manual posts.
export const SOURCE_URL =
  'https://raw.githubusercontent.com/XOTT69/dtek/main/state/publications.json';
const TIME_ZONE='Europe/Kyiv';
const WEEKDAYS=['Неділя','Понеділок','Вівторок','Середа','Четвер',"П'ятниця",'Субота'];

export function kyivDate(now=new Date()) {
  const parts=new Intl.DateTimeFormat('en-GB',{
    timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(now);
  const p=k=>parts.find(x=>x.type===k)?.value;
  return p('year')+'-'+p('month')+'-'+p('day');
}
export function nextDate(date) {
  const [y,m,d]=date.split('-').map(Number);
  return new Date(Date.UTC(y,m-1,d+1,12)).toISOString().slice(0,10);
}
function hhmm(minutes) {
  return String(Math.floor(minutes/60)).padStart(2,'0')+':'+
    String(minutes%60).padStart(2,'0');
}
export function validatedPeriods(rows) {
  if(!Array.isArray(rows)) return null;
  let endOfPrevious=0;
  const result=[];
  for(const row of rows) {
    if(!Array.isArray(row)||row.length!==2) return null;
    const [start,end]=row;
    if(!Number.isInteger(start)||!Number.isInteger(end)||
      start<endOfPrevious||start<0||end>1440||end<=start||
      start%30!==0||end%30!==0) return null;
    result.push([start,end]);
    endOfPrevious=end;
  }
  return result;
}
function safe(value) {
  return String(value??'').replace(/&/g,'&amp;')
    .replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
export function humanDate(date) {
  const [y,m,d]=date.split('-').map(Number);
  const weekday=new Date(Date.UTC(y,m-1,d,12)).getUTCDay();
  return WEEKDAYS[weekday]+', '+String(d).padStart(2,'0')+'.'+
    String(m).padStart(2,'0')+'.'+y;
}
export function confirmed22(state,date) {
  const daily=state?.confirmedSchedules?.[date];
  // The source only persists complete confirmed 12-group "fact" days.
  // Require the whole day to be present, not just a scraped 2.2 guess.
  if(!daily || Object.keys(daily).length!==12) return null;
  return validatedPeriods(daily['2.2']);
}
export function emergencyWarning(status) {
  if(!status?.active) return '';
  const districts=Array.isArray(status.districts) ?
    status.districts.map(d=>safe(d)+' район').join(', ') : '';
  const location=districts || 'Київська область (територію не уточнено)';
  return '\n\n⚠️ <b>Увага!</b> '+
    (status.kind==='екстрені'?'Екстрені':'Аварійні')+
    ' відключення: '+location+'. '+
    (status.kind==='екстрені'?
      'Погодинний графік на зазначених територіях не діє.':
      'Можливі відключення поза графіком.');
}
export function format22(date,periods,{today,emergency=null}={}) {
  // Absolute date prevents a "tomorrow -> today" label change from
  // looking like a real timetable update or leaving a stale relative label.
  const lines=[
    '💡 <b>Графік відключення світла</b>',
    '📆 <b>'+safe(humanDate(date))+'</b>',
    '',
    '💡<b>Підгрупа 2.2 відключення:</b>'
  ];
  if(!periods.length) lines.push('✅ За графіком відключень немає.');
  else {
    for(const [start,end] of periods) {
      const hours=((end-start)/60).toFixed(1);
      lines.push('❌з '+hhmm(start)+' до '+hhmm(end)+' ('+hours+' год)');
    }
    const total=periods.reduce((v,[a,b])=>v+b-a,0)/60;
    lines.push('⚫ <b>Разом без світла: '+total.toFixed(1)+' год</b>');
  }
  // This is a historical channel post, not a live status display:
  // never stamp a time-sensitive emergency status that may later be lifted.
  // The official DTEK account remains the source for emergency bulletins.
  lines.push('', 'ℹ️ Під час екстрених відключень погодинний графік може не діяти.');
  return lines.join('\n').trim();
}
export function choosePosts(state,now=new Date()) {
  const today=kyivDate(now);
  return [today,nextDate(today)].flatMap(date=>{
    const periods=confirmed22(state,date);
    if(!periods) return [];
    return [{date,periods,text:format22(date,periods,{today})}];
  });
}


/** Canonical version key: only a date or confirmed cutoff change creates a post. */
export function scheduleFingerprint(date,periods) {
  const normalized=validatedPeriods(periods);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||normalized===null)
    throw new Error('Invalid confirmed schedule for fingerprint');
  return JSON.stringify({date,periods:normalized});
}

/** Helps existing deployments migrate from text-based, edited message state. */
export function scheduleFingerprintFromText(date,text) {
  if(typeof text!=='string')return null;
  const matches=[...text.matchAll(/❌\s*з\s*(\d{2}):(\d{2})\s*до\s*(\d{2}):(\d{2})/gu)];
  if(!matches.length) {
    if(!/відключень\s+немає/iu.test(text))return null;
    return scheduleFingerprint(date,[]);
  }
  const periods=matches.map(m=>[
    Number(m[1])*60+Number(m[2]),
    Number(m[3])*60+Number(m[4])
  ]);
  if(validatedPeriods(periods)===null)return null;
  return scheduleFingerprint(date,periods);
}
