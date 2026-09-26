const sports = [
  ["soccer_epl","Fútbol Premier League"],
  ["basketball_nba","NBA"],
  ["americanfootball_nfl","NFL"],
  ["baseball_mlb","MLB"],
  ["icehockey_nhl","NHL"],
];

const key = process.env.ODDS_API_KEY || process.env.THE_ODDS_API_KEY;
if (!key) throw new Error("ODDS_API_KEY or THE_ODDS_API_KEY is required");

async function fetchSport(sport, label) {
  const u = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`);
  u.searchParams.set("apiKey", key);
  u.searchParams.set("regions", "us");
  u.searchParams.set("markets", "h2h");
  u.searchParams.set("oddsFormat", "decimal");
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${label}: HTTP ${r.status}`);
  const events = await r.json();
  return events.flatMap(e => {
    const outcomes = (e.bookmakers || []).flatMap(b => (b.markets || [])
      .filter(m => m.key === "h2h")
      .flatMap(m => m.outcomes || []));
    const best = outcomes.filter(o => Number.isFinite(o.price) && o.price > 1)
      .sort((a,b) => a.price-b.price)[0];
    if (!best || Date.parse(e.commence_time) <= Date.now()) return [];
    return [{eventId:e.id,sport,label,commenceTime:e.commence_time,homeTeam:e.home_team,awayTeam:e.away_team,selection:best.name,price:best.price,impliedProbability:1/best.price}];
  });
}

const rows = [];
for (const [sport,label] of sports) {
  try { rows.push(...await fetchSport(sport,label)); }
  catch (e) { console.warn(String(e)); }
}
const unique = [...new Map(rows.map(x => [x.eventId,x])).values()]
  .sort((a,b) => b.impliedProbability-a.impliedProbability);
const triplets = [];
for (let i=0; i+2<unique.length && triplets.length<10; i+=3) {
  const selections=unique.slice(i,i+3);
  triplets.push({
    id:`paper-triplet-${Date.now()}-${triplets.length+1}`,
    createdAt:new Date().toISOString(),
    mode:"PAPER",
    selections,
    combinedPrice:selections.reduce((v,x)=>v*x.price,1),
    combinedImpliedProbability:selections.reduce((v,x)=>v*x.impliedProbability,1)
  });
}
const output={mode:"PAPER",source:"THE_ODDS_API",generatedAt:new Date().toISOString(),selectionCount:unique.length,triplets};
console.log(JSON.stringify(output,null,2));
