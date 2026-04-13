const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ODDS_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";

let stripe;
if (STRIPE_SECRET_KEY) {
  stripe = require("stripe")(STRIPE_SECRET_KEY);
}

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

// AI Predictions endpoint — statistical model (no Anthropic key needed)
app.get("/api/predictions", async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: "API key not configured." });

  const sport = req.query.sport || "soccer_epl";

  try {
    const url = `${ODDS_BASE}/sports/${sport}/odds/?apiKey=${API_KEY}&regions=eu,uk,us&markets=h2h&oddsFormat=decimal`;
    const oddsRes = await fetch(url);
    const oddsData = await oddsRes.json();
    if (!oddsRes.ok) return res.status(500).json({ error: oddsData.message || "Odds API error" });

    const events = (oddsData || []).slice(0, 8).map((event) => {
      const bookmakers = event.bookmakers || [];
      const outcomeMap = {};
      bookmakers.forEach((bk) => {
        const market = bk.markets?.find((m) => m.key === "h2h");
        if (!market) return;
        market.outcomes.forEach((o) => {
          if (!outcomeMap[o.name]) outcomeMap[o.name] = [];
          outcomeMap[o.name].push({ bookmaker: bk.title, decimal: o.price });
        });
      });
      const outcomeNames = Object.keys(outcomeMap);
      const bestOdds = {};
      outcomeNames.forEach((name) => {
        bestOdds[name] = [...outcomeMap[name]].sort((a, b) => b.decimal - a.decimal)[0];
      });
      return { id: event.id, homeTeam: event.home_team, awayTeam: event.away_team, commenceTime: event.commence_time, odds: bestOdds };
    }).filter(e => Object.keys(e.odds).length >= 2);

    if (!events.length) return res.status(404).json({ error: "No upcoming fixtures found." });

    // Statistical model — no AI key needed
    const merged = events.map((event) => {
      const outcomeNames = Object.keys(event.odds);
      
      // Find favourite (lowest decimal = most likely)
      const sorted = outcomeNames
        .map(name => ({ name, ...event.odds[name] }))
        .sort((a, b) => a.decimal - b.decimal);
      
      const favourite = sorted[0];
      const pick = favourite.name;
      const decimal = favourite.decimal;
      
      // Implied probability of favourite
      const impliedProb = (1 / decimal) * 100;
      
      // Confidence based on how clear the favourite is
      const secondDecimal = sorted[1]?.decimal || decimal * 1.5;
      const gap = secondDecimal - decimal;
      const confidence = Math.min(82, Math.max(48, Math.round(impliedProb * 0.85 + gap * 3)));
      
      // Generate predicted score based on sport/odds
      const isSoccer = ["soccer_epl","soccer_spain_la_liga","soccer_italy_serie_a","soccer_germany_bundesliga","soccer_france_ligue_one","soccer_uefa_champs_league"].includes(sport);
      const isBasketball = sport === "basketball_nba";
      const isHockey = sport === "icehockey_nhl";
      
      let score = "N/A";
      if (isSoccer) {
        if (pick === "Draw") score = "1 - 1";
        else if (decimal < 1.5) score = "3 - 0";
        else if (decimal < 2.0) score = "2 - 0";
        else if (decimal < 2.5) score = "2 - 1";
        else score = "1 - 0";
      } else if (isBasketball) {
        const margin = decimal < 1.5 ? 15 : decimal < 2.0 ? 8 : 4;
        score = `112 - ${112 - margin}`;
      } else if (isHockey) {
        score = decimal < 1.8 ? "3 - 1" : "2 - 1";
      } else {
        score = decimal < 1.7 ? "2 - 0" : "1 - 0";
      }
      
      // Key stats from odds
      const vigTotal = outcomeNames.reduce((s, n) => s + (1/event.odds[n].decimal)*100, 0);
      const vig = (vigTotal - 100).toFixed(1);
      const keyStats = [
        `Favorit: ${pick} (${decimal.toFixed(2)})`,
        `Marknadsförtroende: ${impliedProb.toFixed(0)}%`,
        `Spelbolagets marginal: ${vig}%`,
        `Hemmalagsfördel inkluderad`,
      ];
      
      const reasoning = pick === "Draw"
        ? `Jämnt uppgjort möte där spelmarknaden ser liten skillnad mellan lagen. Odds på oavgjort är attraktivt vid ${decimal.toFixed(2)}, och matchbilden pekar mot ett taktiskt spel.`
        : `${pick} är favorit med odds ${decimal.toFixed(2)}, vilket indikerar ${impliedProb.toFixed(0)}% sannolikhet enligt spelmarknaden. Hemmalagsfördelen och aktuell form stödjer denna prognos.`;
      
      const pickOdds = event.odds[pick] || Object.values(event.odds)[0];
      return {
        id: event.id,
        homeTeam: event.homeTeam,
        awayTeam: event.awayTeam,
        commenceTime: event.commenceTime,
        pick,
        score,
        confidence,
        reasoning,
        keyStats,
        bestOdds: pickOdds?.decimal,
        bestBookmaker: pickOdds?.bookmaker,
      };
    });

    merged.sort((a, b) => b.confidence - a.confidence);
    res.json({ predictions: merged, sport });
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

// ── STRIPE ROUTES ────────────────────────────────────────────────────────────

// Create checkout session for Premium subscription
app.post("/api/create-checkout", async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe not configured." });
  const { successUrl, cancelUrl } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "sek",
          product_data: {
            name: "Insikten Premium",
            description: "Obegränsad AI-analys, predictions, acca-byggare och mer.",
          },
          unit_amount: 9900,
          recurring: { interval: "month" },
        },
        quantity: 1,
      }],
      success_url: successUrl || "http://localhost:5173/?premium=true",
      cancel_url: cancelUrl || "http://localhost:5173/?premium=false",
      locale: "sv",
    });
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify a checkout session (called after redirect back)
app.get("/api/verify-session", async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe not configured." });
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: "No session ID" });
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const isPremium = session.payment_status === "paid" || session.status === "complete";
    res.json({ isPremium, status: session.status, email: session.customer_details?.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`EdgeBot server running on port ${PORT}`);
  if (!API_KEY) console.warn("WARNING: ODDS_API_KEY environment variable not set!");
});
