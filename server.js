const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ODDS_API_KEY;

app.use(cors());
app.use(express.json());

const ODDS_BASE = "https://api.the-odds-api.com/v4";

// ── helpers ──────────────────────────────────────────────────────────────────

function decimalToImplied(d) { return d ? (1 / d) * 100 : 0; }

function removeVig(probs) {
  const total = probs.reduce((s, p) => s + p, 0);
  return probs.map((p) => (p / total) * 100);
}

function kellyStake(bankroll, fairProb, decimal, frac = 0.25) {
  if (!decimal || decimal <= 1) return 0;
  const b = decimal - 1, p = fairProb / 100, q = 1 - p;
  const k = (b * p - q) / b;
  return Math.max(0, k * frac * bankroll);
}

function decimalToAmerican(d) {
  if (!d || d <= 1) return "N/A";
  if (d >= 2) return "+" + Math.round((d - 1) * 100);
  return "-" + Math.round(100 / (d - 1));
}

function analyseEvent(event, marketKey, bankroll = 1000, minEdge = 1.5) {
  const bookmakers = event.bookmakers || [];
  if (!bookmakers.length) return null;

  const outcomeMap = {};
  bookmakers.forEach((bk) => {
    const market = bk.markets?.find((m) => m.key === marketKey);
    if (!market) return;
    market.outcomes.forEach((o) => {
      if (!outcomeMap[o.name]) outcomeMap[o.name] = [];
      outcomeMap[o.name].push({ bookmaker: bk.title, decimal: o.price, point: o.point });
    });
  });

  const outcomeNames = Object.keys(outcomeMap);
  if (outcomeNames.length < 2) return null;

  const bestOdds = {};
  outcomeNames.forEach((name) => {
    bestOdds[name] = [...outcomeMap[name]].sort((a, b) => b.decimal - a.decimal)[0];
  });

  const avgImplied = {};
  outcomeNames.forEach((name) => {
    const odds = outcomeMap[name];
    avgImplied[name] = odds.reduce((s, o) => s + decimalToImplied(o.decimal), 0) / odds.length;
  });

  const fairProbs = removeVig(outcomeNames.map((n) => avgImplied[n]));
  const fairMap = {};
  outcomeNames.forEach((n, i) => { fairMap[n] = fairProbs[i]; });
  const vig = outcomeNames.map((n) => avgImplied[n]).reduce((s, p) => s + p, 0) - 100;

  const bets = outcomeNames.map((name) => {
    const best = bestOdds[name];
    const fair = fairMap[name];
    const implied = decimalToImplied(best.decimal);
    const edge = fair - implied;
    const stake = edge > 0 ? kellyStake(bankroll, fair, best.decimal, 0.25) : 0;
    return {
      name,
      bestBookmaker: best.bookmaker,
      decimal: best.decimal,
      american: decimalToAmerican(best.decimal),
      fair: Math.round(fair * 10) / 10,
      implied: Math.round(implied * 10) / 10,
      edge: Math.round(edge * 100) / 100,
      stake: Math.round(stake * 100) / 100,
      numBooks: outcomeMap[name].length,
      allOdds: outcomeMap[name].sort((a, b) => b.decimal - a.decimal),
    };
  });

  const bestBet = bets.reduce((b, curr) => (!b || curr.edge > b.edge) ? curr : b, null);
  if (!bestBet || bestBet.edge < minEdge) return null;

  return {
    id: event.id,
    sport: event.sport_title,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    commenceTime: event.commence_time,
    bets,
    bestBet,
    vig: Math.round(vig * 100) / 100,
    bookmakerCount: bookmakers.length,
  };
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Get value bets for a sport + market
app.get("/api/bets", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: "API key not configured on server." });
  }

  const sport = req.query.sport || "soccer_epl";
  const market = req.query.market || "h2h";
  const minEdge = parseFloat(req.query.minEdge) || 1.5;
  const bankroll = parseFloat(req.query.bankroll) || 1000;

  try {
    const url = `${ODDS_BASE}/sports/${sport}/odds/?apiKey=${API_KEY}&regions=eu,uk,us&markets=${market}&oddsFormat=decimal`;
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || "Odds API error" });
    }

    const valueBets = data
      .map((event) => analyseEvent(event, market, bankroll, minEdge))
      .filter(Boolean)
      .sort((a, b) => b.bestBet.edge - a.bestBet.edge);

    res.json({
      sport,
      market,
      count: valueBets.length,
      timestamp: new Date().toISOString(),
      bets: valueBets,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get available sports
app.get("/api/sports", async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: "API key not configured." });
  try {
    const response = await fetch(`${ODDS_BASE}/sports/?apiKey=${API_KEY}`);
    const data = await response.json();
    const active = data.filter((s) => s.active);
    res.json(active);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`EdgeBot server running on port ${PORT}`);
  if (!API_KEY) console.warn("WARNING: ODDS_API_KEY environment variable not set!");
});
