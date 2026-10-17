import {kyivDate,nextDate,validatedPeriods,humanDate} from './schedule22.js';

export const SUBGROUPS=Array.from({length:6},(_,i)=>[String(i+1)+'.1',String(i+1)+'.2']).flat();
const BASE_BUTTONS=[
  ['💡 Сьогодні','📅 Завтра'],
  ['🕒 Зараз','⏳ Наступне'],
  ['📊 Статистика','📚 Календар'],
  ['🏠 Моя підгрупа','⚙️ Налаштування'],
  ['📤 Поділитися','❓ Допомога']
];
export function keyboard(scope='plaza',selecting=false) {
  const rows=selecting && scope==='dtek' ?
    [...Array.from({length:6},(_,i)=>['🏘 '+(i+1)+'.1','🏘 '+(i+1)+'.2']),['↩️ Меню']] :
    scope==='plaza' ? BASE_BUTTONS.filter(row=>!row.includes('🏠 Моя підгрупа')) : BASE_BUTTONS;
  return {keyboard:rows.map(row=>row.map(text=>({text}))),resize_keyboard:true,is_persistent:true};
}

export function defaultProfile(scope) {
  return {group:'2.2',quiet:true,lead:30,createdAt:null,scope};
}
export function normalizedProfile(source,scope) {
  const input=source && typeof source==='object'&&!Array.isArray(source)?source:{};
  return {
    group:scope==='plaza'?'2.2':SUBGROUPS.includes(input.group)?input.group:'2.2',
    quiet:input.quiet!==false,lead:[10,30,60].includes(input.lead)?input.lead:30,
    createdAt:typeof input.createdAt==='string'?input.createdAt:null,scope
  };
}
const hhmm=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+
  String(m%60).padStart(2,'0');
const hours=m=>{
  const h=Math.floor(m/60),mins=m%60;
  return (h?h+' год':'')+(mins?(h?' ':'')+mins+' хв':'')||'0 хв';
};
const sum=periods=>periods.reduce((v,[start,end])=>v+end-start,0);
function clearIntervals(periods) {
  const result=[];
  let end=0;
  for(const [from,to] of periods){
    if(from>end)result.push([end,from]);
    end=to;
  }
  if(end<1440)result.push([end,1440]);
  return result;
}
function localMinutes(now) {
  const parts=new Intl.DateTimeFormat('en-GB',{
    timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  }).formatToParts(now);
  const part=x=>Number(parts.find(p=>p.type===x)?.value);
  return part('hour')*60+part('minute');
}
export function confirmedPersonalPeriods(state,date,group) {
  const daily=state?.confirmedSchedules?.[date];
  if(!daily||Object.keys(daily).length!==12||!SUBGROUPS.every(g=>g in daily))
    return null;
  return validatedPeriods(daily[group]);
}
function scheduleFor(state,date,group,scope,override) {
  if(scope==='plaza' && group==='2.2' && override?.date===date &&
     validatedPeriods(override.periods)!==null)
    return override.periods;
  return confirmedPersonalPeriods(state,date,group);
}
function headline(date,today,updated=false) {
  return (updated?'🔄 Оновлений':'💡')+
    (updated?' графік':' Графік')+
    (date===nextDate(today)?' на завтра':'') ;
}
function heading(date,today,group){
  return '💡 <b>Графік '+group+(date===nextDate(today)?' на завтра':'')+'</b>\n'+
    '📆 '+humanDate(date)+'\n\n';
}
function formatPeriodList(periods){
  if(periods.length===0)return '✅ Планових відключень немає.';
  return periods.map(([a,b])=>'❌ '+hhmm(a)+'–'+hhmm(b)+' · '+hours(b-a)).join('\n');
}
function out(date,today,group,periods) {
  if(!periods)
    return '⏳ Немає повного підтвердженого графіка для підгрупи '+group+
      ' на '+(date===today?'сьогодні':'завтра')+'. Спробуй пізніше.';
  return heading(date,today,group)+formatPeriodList(periods)+'\n\n'+
    '⚫ <b>Без світла: '+hours(sum(periods))+'</b>\n'+
    '🟢 За планом зі світлом: '+hours(1440-sum(periods))+
    '\n\nℹ️ Це плановий графік, а не фактична наявність електроенергії.';
}
function intro(scope,group) {
  const welcome=scope==='plaza'?'🏘 <b>Плаза · підгрупа 2.2</b>':'💡 <b>Мій ДТЕК · підгрупа '+group+'</b>';
  return welcome+'\n\nВибери потрібний розділ кнопками нижче. '+
    'Графіки підтверджені ДТЕК, а не відображають фактичний стан мережі.';
}
function history(state,today,group) {
  const dates=Object.keys(state?.confirmedSchedules||{}).filter(date=>
    /^20\d\d-\d\d-\d\d$/.test(date)&&date<=nextDate(today) &&
    confirmedPersonalPeriods(state,date,group)!==null).sort().reverse().slice(0,7);
  if(!dates.length)return '📚 Немає збережених підтверджених графіків.';
  return '📚 <b>Календар графіків · '+group+'</b>\n\n'+
    dates.map(date=>'📆 '+humanDate(date)+' · '+hours(sum(confirmedPersonalPeriods(state,date,group)))+' без світла').join('\n')+
    '\n\nℹ️ Показано доступні підтверджені дні.';
}
function statusToday(now,today,group,periods) {
  if(!periods)return '⏳ Немає підтвердженого графіка на сьогодні для '+group+'.';
  const minute=localMinutes(now);
  const blocked=periods.find(([a,b])=>a<=minute&&minute<b);
  if(blocked){
    return '🕒 <b>Зараз за графіком · '+group+'</b>\n\n'+
      '🔴 Планове відключення '+hhmm(blocked[0])+'–'+hhmm(blocked[1])+
      '\n⏳ До завершення планового періоду: '+hours(blocked[1]-minute)+
      '\n\nℹ️ Фактичну наявність світла не підтверджено.';
  }
  const next=periods.find(([a])=>a>minute);
  return '🕒 <b>Зараз за графіком · '+group+'</b>\n\n'+
    '🟢 Планового відключення зараз немає.'+
    (next?'\n⏳ Наступне о '+hhmm(next[0])+' через '+hours(next[0]-minute):
      '\n✅ До кінця доби нових відключень немає.')+
    '\n\nℹ️ Фактичну наявність світла не підтверджено.';
}
function upcoming(now,today,group,periods,tomorrowPeriods) {
  if(!periods)return '⏳ Ще немає підтвердженого графіка на сьогодні.';
  const minute=localMinutes(now);
  const todayNext=periods.find(([a])=>a>minute);
  if(todayNext)return '⏳ <b>Наступне планове відключення · '+group+'</b>\n\n'+
    '🔴 Сьогодні о '+hhmm(todayNext[0])+'–'+hhmm(todayNext[1])+
    '\nДо початку: <b>'+hours(todayNext[0]-minute)+'</b>';
  if(!tomorrowPeriods)return '✅ Сьогодні нових відключень немає.\n⏳ Графік на завтра ще не підтверджений.';
  if(!tomorrowPeriods.length)return '✅ До кінця сьогодні та за графіком завтра відключень немає.';
  const next=tomorrowPeriods[0];
  return '⏳ <b>Наступне планове відключення · '+group+'</b>\n\n'+
    '🔴 Завтра о '+hhmm(next[0])+'–'+hhmm(next[1])+
    '\nДо початку: <b>'+hours(1440-minute+next[0])+'</b>';
}
function statistics(date,today,group,periods){
  if(!periods)return '⏳ Немає підтверджених даних для статистики.';
  const longestOff=Math.max(0,...periods.map(([a,b])=>b-a));
  const longestOn=Math.max(0,...clearIntervals(periods).map(([a,b])=>b-a));
  return '📊 <b>Статистика · '+group+'</b>\n📆 '+humanDate(date)+
    '\n\n🔴 Без світла: '+hours(sum(periods))+
    '\n🟢 За графіком зі світлом: '+hours(1440-sum(periods))+
    '\n⏳ Найдовше відключення: '+hours(longestOff)+
    '\n💡 Найдовше зі світлом: '+hours(longestOn)+
    '\n\nℹ️ Розрахунок за плановим графіком.';
}
export function personalAction({scope='plaza',text='',profile={},now=new Date(),state={},override=null}={}){
  const message=String(text).trim();
  const lower=message.toLowerCase();
  const pref=normalizedProfile(profile,scope);
  const today=kyivDate(now),tomorrow=nextDate(today),group=pref.group;
  const get=date=>scheduleFor(state,date,group,scope,override);
  const initial=message==='/start'||message==='/menu'||message==='↩️ Меню';
  let answer=null,selecting=false,changed=false;
  if(initial)answer=intro(scope,group);
  else if(message==='💡 Сьогодні'||message==='/today'||message==='/graph')
    answer=out(today,today,group,get(today));
  else if(message==='📅 Завтра'||message==='/tomorrow')
    answer=out(tomorrow,today,group,get(tomorrow));
  else if(message==='🕒 Зараз'||message==='/now')
    answer=statusToday(now,today,group,get(today));
  else if(message==='⏳ Наступне'||message==='/next')
    answer=upcoming(now,today,group,get(today),get(tomorrow));
  else if(message==='📊 Статистика'||message==='/stats')
    answer=statistics(today,today,group,get(today));
  else if(message==='📚 Календар'||message==='/history')
    answer=history(state,today,group);
  else if(message==='📤 Поділитися')
    answer=out(today,today,group,get(today))+
      '\n\n📤 Перешли це повідомлення рідним або сусідам.';
  else if(message==='🏠 Моя підгрупа' && scope==='dtek'){
    answer='🏘 <b>Оберіть свою підгрупу</b>\n\nНатисніть одну з кнопок нижче.';
    selecting=true;
  }
  else if(scope==='dtek' && (/^🏘 [1-6]\.[12]$/.test(message)||/^\/group [1-6]\.[12]$/.test(message))){
    const selected=message.replace(/^🏘 /,'').replace(/^\/group /,'');
    if(SUBGROUPS.includes(selected)){
      pref.group=selected;changed=true;answer='✅ Збережено підгрупу <b>'+selected+'</b>.\n\n'+intro(scope,selected);
    }
  }else if(message==='⚙️ Налаштування'||message==='/settings')
    answer='⚙️ <b>Налаштування</b>\n\n🏘 Моя підгрупа: '+group+
      '\n🌙 Тихий режим: '+(pref.quiet?'увімкнений':'вимкнений')+
      '\n🔔 Інтервал: '+pref.lead+' хв (планується)'+
      '\n\nПерсональну автоматичну розсилку ще не запущено. '+
      'Меню графіків і вибір підгрупи вже працюють.';
  else if(message==='❓ Допомога'||message==='/help')
    answer='❓ <b>Допомога</b>\n\n' +
      '💡 Сьогодні / 📅 Завтра — підтверджені графіки\n'+
      '🕒 Зараз — поточний плановий період\n'+
      '⏳ Наступне — найближчий початок відключення\n'+
      '📊 Статистика — години та найдовші періоди\n'+
      (scope==='dtek'?'🏠 Моя підгрупа — змінити чергу\n':'')+
      '📚 Календар — останні доступні графіки\n\n'+
      '⚠️ Під час екстрених відключень планові години можуть не діяти.';
  if(answer===null)return {handled:false};
  return {handled:true,text:answer,profile:pref,changed,selecting,
    replyMarkup:keyboard(scope,selecting)};
}
