# The feed

Tyler's north star for conch, in his words and then in ours. Everything in
`backlog.md` is groundwork for this; nothing here should be built until the
basics are solid, and nothing in the basics should be built in a way that makes
this harder to reach.

## In his words

> taking the information density and context switching of scrolling on social
> media UI like twitter or ig or tiktok, as well of the visual and iterative
> media nature of it, and making conch more like that. you see a feed of live
> artifacts, maybe with the conversation streaming over top like tiktok comments
> or below like twitter or something, then you can click into it to see more
> detail and interact or u can just swipe to the next one. obv next one in the
> order is whatever needs your attention most crossed with your priorities, we
> try and keep things focused so the ai always has some sort of visual something
> its showing you to then react to, and u can just react with your voice and it
> records what you say while looking at that one, u can stay and chat back and
> forth quick, or swipe up to repeat with the next one, maybe this one has a
> little video you watch and give pointers on, maybe the next one is a website
> so you click to expand and see the full mobile and interact with it and draw a
> circle on the screen saying move this here and it captures all that context
>
> it's taking the entertainment and info density tech that social media
> currently uses for distraction but harnessing it instead for production and
> creation.

## What that means

**The unit of the interface stops being a session and becomes an artifact.**
Today conch shows you a list of sessions and, inside one, a conversation. The
feed inverts that: you are shown a THING — a rendered page, a diff, a chart, a
video, a question — and the conversation is context around it rather than the
main event. A session becomes an author, not a destination.

**Order is a judgement, not a timestamp.** What surfaces next is whatever needs
you most, weighted by what you care about. That is conch's hardest and most
valuable problem, and the one nothing else on the desk solves: five agents
working produce more surfaces than a person can attend to, and choosing well is
the entire product.

**Every agent should always have something to show.** The feed is empty if
agents only speak in prose. This reframes `review_to_front` from an occasional
approval gate into the normal way work is surfaced — which means the plugin's
current advice to "surface sparingly" is aimed in the wrong direction for where
this is going.

**Reacting is the primitive.** Voice while looking at the thing, capturing what
you said AND what you were looking at when you said it. Drawing on it. A quick
back-and-forth without leaving. Swiping past. All of these are the same verb —
respond to what is in front of you — and none of them should require finding a
text field first.

**Context is captured, not described.** "Move this here" plus a circle drawn on
a screenshot carries more than a paragraph would, and takes a second instead of
a minute. The interface should collect that pointing rather than asking you to
translate it into words.

## Sequenced last, deliberately (2026-08-18)

Tyler, after seeing how much of the groundwork exists: *"lets not do stage 3
yet then - lets perfect the rest and then stage 3 will be like an alt view of
the current app."*

That is a decision about SHAPE as much as order. The feed is not a second
product to be built beside this one; it is a second VIEW over the same data,
reached from the app that already exists. Which sets a standard for everything
built before it: every surface conch learns about — plugins that need
attention, an MCP server that needs auth, a blocked subagent, a failed hook, a
question waiting — should arrive as a rankable item with a subject, not as a
screen. Build those as screens and the feed becomes a rewrite; build them as
items and the feed becomes a lens.

The section below still holds for what the feed IS. It just no longer implies
it has to be built early to be built right.

## Why this is not a skin on the current app

The current app asks: which session do you want to look at? The feed asks:
here is the most important thing right now — what do you think? The second
question cannot be answered by rearranging the first one's screens.

Two things in today's build already point at it and are worth protecting:
`review_to_front`, which is a primitive feed item wearing a different name, and
the voice loop, which is already "react to a thing without typing".

## What it inherits from social media, and what it must not

**Inherit:** density without clutter; a single decisive gesture between items;
never showing an empty state; media treated as first-class rather than as an
attachment; the sense that the next thing is worth seeing.

**Refuse:** the infinite tail. A feed for production has a bottom — the point is
to reach it. Anything that optimises for time-in-app is working against the
person using it. Success is a short session that ends because the work is
attended to, not a long one that ends because they gave up.
