const explanations = {
  'timing benefit': 'The same recorded energy is priced twice: at the prices when it was used, and at each whole day’s duration-weighted average all-in price. The difference describes timing. It does not prove savings caused by this controller.',
  estimated: 'Energy is estimated from the available electrical readings or heat-pump operating data. Phase allocation and integration between readings are approximate. Older current-only history also assumes 230 V. Meter accuracy checks do not correct these estimates.',
  'assumed rates': 'Some dates lack a dated electricity contract. The nearest known contract rates are used with those dates’ spot prices. This assumption affects both the actual-timing cost and the daily comparison; it is not a verified historical bill.',
  provisional: 'This comparison includes an unfinished day or incomplete recorded energy coverage. It can change when further energy or prices become available. The daily reference still requires a complete day of spot prices.',
  coverage: 'The percentage of the selected elapsed time with usable energy and complete whole-day prices. Missing intervals are excluded, not treated as zero consumption. This is data coverage, not statistical confidence.',
};
let nextId = 0;
const openTips = new Set();
const rendered = new WeakMap();
function closeTips(except) { for (const tip of openTips) if(tip!==except) tip.close(); }
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown',event=>{for(const tip of openTips)if(!tip.wrap.contains(event.target))tip.close();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeTips();});
  window.addEventListener('resize',()=>closeTips());
  window.addEventListener('scroll',()=>{for(const tip of openTips)tip.position();},{passive:true});
}
function explain(label,key,basis) {
  const wrap=document.createElement('span'),button=document.createElement('button'),popup=document.createElement('span');
  wrap.className='explain';button.type='button';button.className='explain-trigger';button.textContent=label;
  popup.className='explain-popup';popup.id=`timing-explanation-${++nextId}`;popup.role='tooltip';popup.hidden=true;
  popup.textContent=explanations[key]+(key==='estimated'&&basis?` ${basis}`:'');
  button.setAttribute('aria-describedby',popup.id);button.setAttribute('aria-expanded','false');
  let pinned=false;
  const tip={wrap,position,close(){popup.hidden=true;pinned=false;button.setAttribute('aria-expanded','false');openTips.delete(tip);}};
  function position(){
    const bounds=button.getBoundingClientRect(),width=Math.min(340,window.innerWidth-32);
    if(bounds.bottom<0||bounds.top>window.innerHeight){tip.close();return;}
    popup.style.width=`${width}px`;popup.style.left=`${Math.max(16,Math.min(bounds.left,window.innerWidth-width-16))}px`;
    const height=popup.getBoundingClientRect().height;
    popup.style.top=`${bounds.bottom+height+12<window.innerHeight?bounds.bottom+8:Math.max(8,bounds.top-height-8)}px`;
  }
  function show(){
    closeTips(tip);popup.hidden=false;openTips.add(tip);button.setAttribute('aria-expanded','true');position();
  }
  button.addEventListener('pointerenter',event=>{if(event.pointerType!=='touch')show();});
  wrap.addEventListener('pointerleave',()=>{if(!pinned&&document.activeElement!==button)tip.close();});
  button.addEventListener('focus',show);
  button.addEventListener('blur',()=>{if(!pinned)tip.close();});
  button.addEventListener('click',()=>{if(pinned)tip.close();else{pinned=true;show();}});
  wrap.append(button,popup);return wrap;
}

export function renderTimingBenefit(payload,root) {
  if(!root)return;
  const fingerprint=JSON.stringify(payload?.timingBenefit??{});
  if(rendered.get(root)===fingerprint)return;
  rendered.set(root,fingerprint);
  closeTips();root.replaceChildren();
  const money=value=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'EUR',maximumFractionDigits:2}).format(value);
  for(const [key,name] of [['heatPump','Heat pump'],['charger','Charger']]) {
    const result=payload?.timingBenefit?.[key],row=document.createElement('p'),title=document.createElement('strong');
    row.className=`timing-device timing-${key}`;title.textContent=`${name}: `;row.append(title);
    if(Number.isFinite(result?.value)) {
      row.append(`${money(result.value)} `,explain('timing benefit','timing benefit'), ' · ',explain('estimated','estimated',result.basis));
      for(const [flag,label] of [['assumedPrices','assumed rates'],['provisional','provisional']])if(result[flag])row.append(' · ',explain(label,label));
      row.append(' · ',explain(`${Math.round(result.coverage*100)}% coverage`,'coverage'));
    } else row.append('Timing comparison unavailable · energy and full-day prices needed');
    root.append(row);
  }
  const note=document.createElement('p');note.className='timing-explanation';
  note.textContent='Same recorded energy at each whole day’s average all-in price. Positive = cheaper timing; negative = dearer. Missing energy periods and days with incomplete spot prices are excluded. Not proven controller savings.';
  root.append(note);
}
