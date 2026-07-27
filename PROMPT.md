# Halfspace — build brief

> **Working document, not for publication.** This is the internal spec used to build the project.
> Delete it in the same commit that makes this repo public — the README replaces it.

---

# Build **Halfspace** — a phase-search engine for football analysts

## Who you are and what this is for

You are building a portfolio project that has one job: get me an interview for the **Research
Engineer** role in Arsenal FC's Data Analytics team, embedded with Men's First Team Analysis.

Read that sentence again, because it changes engineering decisions throughout. This is not a
personal side project. It will be opened by a Head of Software & Analytics and a Head of Analysis,
on a laptop, for about ninety seconds, alongside a stack of other applications. Every decision
should optimise for that ninety seconds and for the interview conversation that follows it.

What that team said publicly about the role: it "will focus on building the **application layer**
for our research." The person spec leads with full-stack engineering, `Python`, `SQL`,
`JavaScript/TypeScript`, the PyData stack (`numpy`, `Pandas/Polars`, `matplotlib/seaborn/Altair`),
an "eye for design" in data presentation, and the ability to communicate with non-technical
colleagues. Deep-learning frameworks are listed as *desirable*, not required. Two responsibilities
matter most: **"design and develop full-stack applications"** and **"automate football analysis
tasks that are currently done manually."**

So: **build a tool, not a model.** A polished, deployed, fast application that an analyst could
actually use beats a clever notebook. Most applicants will send a notebook.

## The problem the tool solves

A first-team analyst wants to answer questions like:

> "Show me every time the opposition played out from the back against our high press and we won
> the ball in their defensive third."

Today that means scrubbing video and hand-tagging. It costs hours per match. It is exactly the kind
of manual work the job advert asks to automate.

**Halfspace makes football phases searchable.** You describe a pattern of play in plain English; it
returns the matching passages, ranked, each replayable as an animation on a pitch. Then you say
"more like this one" and it finds similar passages across every other match.

## Data

**StatsBomb Open Data** — https://github.com/statsbomb/open-data — free, public, real competitions.
Some matches include **StatsBomb 360** freeze frames giving other players' positions at event time,
which is what makes real phase animation possible rather than just a ball trace.

Before writing any pipeline code:
1. Read StatsBomb's official data spec documents in that repo. Do not guess at the schema, the
   coordinate system, the event taxonomy, or the meaning of qualifiers. Verify against the spec.
2. Read their user agreement / licence and comply with it exactly, including the attribution they
   require. Put the attribution in the app footer and the README. If the licence forbids something
   you were planning, change the plan, not the licence.
3. Establish which competitions in the open dataset actually have 360 data, and build around those.

## Architecture — and why

```
  ingest/          Python. Polars + DuckDB. Reads raw StatsBomb JSON, builds possession
                   chains, derives phase features, writes Parquet. Runs offline, committed
                   output, never runs in production.

  web/             TypeScript + React. Loads the Parquet directly and queries it with
                   DuckDB-WASM in the browser. No backend needed for search.

  api/             Small FastAPI service. Two jobs only: translate natural language into a
                   validated query, and serve nearest-neighbour similarity. The app must
                   work fully without it.
```

Three deliberate choices, each of which you should be able to defend in an interview:

**DuckDB-WASM in the browser.** Search runs client-side against Parquet. This means sub-100ms
queries, zero hosting cost, nothing to keep warm, and a demo that cannot be down when they open it.
It also means real SQL is visibly central to the project.

**The LLM emits a validated query object, never raw SQL.** Define a small typed query DSL. The
model's job is only to translate English into that DSL. The app validates it against a schema and
executes it deterministically. This is safer, testable, debuggable, and shows better judgment than
free-form SQL generation. Show the parsed query back to the user in the UI so they can see and
correct what it understood — that transparency is the difference between a tool an analyst trusts
and a black box they abandon.

**The app degrades gracefully without the LLM.** A visual filter builder must be able to construct
every query the natural-language path can. If the API key is missing or the service is down, the
tool still works completely. Never let a demo die on someone else's uptime.

## Build order — this is a hard constraint

**P0 must be deployed, working, and demo-able before you start P1. Do not start P1 early. If you
run short on time, an excellent P0 beats a half-finished P2 every single time.**

### P0 — the spine
- Ingest pipeline: raw StatsBomb JSON → possession chains → phase features → Parquet.
- Phase model: segment matches into possessions and passages of play. Derive per-phase features —
  start/end zone, duration, pass count, outcome, pressure applied, progression, whether it began
  from a turnover, a set piece, a goal kick, and so on. Ground every definition in the actual data,
  and document each one in plain English.
- Web app loading Parquet via DuckDB-WASM.
- Visual filter builder covering every feature.
- Results as a ranked grid of small animated pitch thumbnails.
- Click a result → full-size animation: players moving, ball path, scrubbable timeline.
- Deployed to a public URL.

### P1 — the differentiator
- Natural-language input → typed query DSL → validated → executed. Parsed query shown in the UI.
- A handful of preset queries on the landing page, so it is never an empty box.
- "Find similar phases" — start with a deterministic baseline: a feature vector plus cosine
  similarity, computed offline. It must work before anything learned goes near it.

### P2 — only if P0 and P1 are genuinely finished
- Upgrade similarity to a learned sequence encoder in **PyTorch** — a small model over the event
  sequence, trained self-supervised. Include this **only if it measurably beats the P0 baseline on
  a held-out evaluation you actually run**. If it doesn't beat it, say so in the README and keep
  the baseline. That negative result, reported honestly, is more impressive than a model that is
  quietly worse.
- "Save phases to a report" → a shareable opposition-scouting page assembled from saved queries.

## The ninety-second demo path

Design backwards from this. Every step must be smooth, fast, and screenshot-able.

1. Land on the app. A match is already loaded. A pitch is visible. **No empty state, ever.**
2. Click a preset chip: *"high turnovers leading to a shot"*.
3. A ranked grid of animated phase thumbnails appears in under 300ms.
4. Click one. It plays full-size — players, ball, timeline.
5. Click *"find similar"*. Comparable passages surface from other matches.
6. Type your own query in plain English. Same path, same speed.

## Design bar

The person spec asks for an "eye for design" in data presentation. This is being graded on how it
looks, and a football club is a more visually literate employer than most. Treat the interface as
part of the submission, not packaging around it.

- Restrained and confident. Dark, low-chrome, the pitch is the hero. Think broadcast analysis desk
  or a good scouting tool — not a developer dashboard, not a bootstrap template.
- **Do not use Arsenal's crest, kit colours, or branding.** Building a club-liveried app for a club
  you don't work for reads as presumptuous, and it's a trademark problem. Neutral and professional.
- The pitch rendering must be correct: proper proportions, correct markings, attacking direction
  always made explicit. Football people notice immediately when this is wrong.
- Animation should be smooth and interpretable. Player trails, clear ball highlighting, sensible
  easing. If 360 freeze frames are sparse for a phase, show honestly what's known rather than
  interpolating fiction.
- Use **Altair** for the statistical charts — distributions, zone summaries, comparisons. It is
  named in the person spec; use it properly rather than decoratively.
- Responsive. They may well open it on a phone.
- Performance budget: first meaningful paint under 2s on a cold load, search under 300ms.
  Treat these as requirements, and state the numbers you actually achieved in the README.

## Rules

**Correctness over volume.** Every football definition you implement must be defensible. If you
define a "high press turnover", write down the exact criteria, in plain English, in the README. An
analyst will disagree with some of your choices — that's fine and interesting — but they must be
able to *see* what you chose. Vague definitions are the fastest way to lose credibility with this
audience.

**Never fabricate a football insight.** If the README or the UI states a finding, it must come from
a query anyone can re-run in the app. No invented numbers, no plausible-sounding claims you haven't
computed. If a validation check surprises you, investigate it rather than smoothing it over.

**Test the things that would be embarrassing to get wrong.** Coordinate transforms, possession-chain
boundaries, phase feature derivation, the query DSL validator. Property-based tests where they fit.
You do not need exhaustive UI tests.

**Write code I can explain in an interview.** I will be asked how this works. Prefer clear,
conventional structure over clever abstraction. Comment the football logic — the reasoning behind a
definition — not the TypeScript syntax.

**Commit as you go**, with real messages. No AI attribution in commits, no `Co-Authored-By` trailers,
no "Generated with" footers.

**Cut rather than fake.** If something isn't working, remove it and note it in the README's honest
limitations section. A tool that does three things excellently beats one that gestures at eight.

## The README

Write it **last**, describing what actually exists — not what was planned.

Open with a screenshot or a GIF of the animation, then one paragraph on the football question the
tool answers. An analyst should understand the point before encountering a single technical term.
Only then: architecture, the phase definitions in plain English, how to run it, the performance
numbers you measured, honest limitations, and StatsBomb attribution.

Include one section titled **"What I'd do with real tracking data"** — a short, concrete, non-hand-wavy
note on how the approach extends from event data to full tracking. That is the paragraph that gets
read as "this person understands where the field is going."

## When you're done

Give me:
1. The live URL.
2. A short list of what's genuinely strong, and what you'd fix with another week.
3. Three specific things in the codebase an interviewer is most likely to ask about, with the
   answers, so I can prepare.

Now start. Plan first, show me the plan, then build.
