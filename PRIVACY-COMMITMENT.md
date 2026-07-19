# The privacy commitment

> **This document is canonical at the constellation hub, and only there.**
> Read it at
> [`vivijure docs/legal/PRIVACY-COMMITMENT.md`](https://github.com/skyphusion-labs/vivijure/blob/main/docs/legal/PRIVACY-COMMITMENT.md).

The privacy commitment is **product-wide**. It covers every product Skyphusion Labs ships (the
Vivijure constellation, Postern, Prism, Slate), so it lives at the hub in one copy and every product
repository points at it rather than carrying its own. A commitment that exists in six places is a
commitment that will eventually say six different things.

This file is a pointer so they can never drift. Do not paste the text here.

## What it says, in one line

Privacy, autonomy, and agency are the primary goal, ranked above feature completeness rather than
traded against it; when a feature cannot be built without violating that, **we drop the feature, not
the line**; public source is the audit mechanism that makes the promise checkable; and the CSAM and
NCII bright line is the one stated exception.

## Why the pointer sits here

**Slate is self-host only. We do not run it for you.** It is built for other people to run
themselves, so the Discord application, the bot token, the subprocessor relationships, and the
message content all belong to the operator who runs the instance. We ship the code and hold none of
it.

That is what makes this pointer worth more than a boilerplate link. Slate reads Discord message
content, which makes it the most invasive-sounding thing in the product line, and an honest
disclosure about that is genuinely owed. **It is owed by the operator to their users, and it is not
ours to make.**

So if you deploy Slate, this part is yours: you are the data controller. It uses the Discord
**Message Content** intent, it reads the text of messages in every channel it is added to, it
derives and stores storyboard state from them, and it sends content to third parties in order to
function at all. The people in those channels should hear that from you, plainly, before they type.
The commitment's own standard applies to you as much as to us, and Section 1.2 is the part worth
carrying: when a feature cannot be built without crossing the line, drop the feature, not the line.

What the commitment obliges **us** to do here is narrower and still real:

- **Ship software that does not phone home.** No path routes your users' messages back to us, and
  building one would break the commitment.
- **Name the third parties in the code**, so an operator can see the whole data path before deciding
  to run it.
- **Keep the source public (AGPL-3.0)**, so all of the above is checkable rather than trusted.
  Section 1.3 of the canonical copy makes auditability the enforcement mechanism, and a bot that
  reads chat is precisely the case where that matters.

We also run an instance of Slate for our own use. That is us using what we build, the same as
running a local build of Vivijure. It is not a service we offer, and it puts no third party's data
in our hands.

## The tripwire

**If Slate ever grows a component that sends message content, Discord identifiers, or derived state
from a self-hosted instance back to us, or if Skyphusion Labs ever offers Slate as a service to
other people, the commitment stops being true, and whoever ships it owns updating the canonical
document in the same PR.** See the canonical copy for the full set of drift tripwires.
