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

## Why the pointer sits here, said plainly

**Slate is one of the two products where "we hold nothing" is not literally true**, and the
canonical document names it in bold rather than leaving a reader to discover it. Slate is the
hardest case in the inventory and this file does not soften it.

We operate the official Discord instance. It uses the Discord **Message Content** intent, which
means it reads the text of messages in the channels it is added to. It holds that message content,
Discord identifiers, and derived storyboard state, and it sends content to named subprocessors in
order to function at all.

That is a product that reads your conversation. Calling it privacy-preserving without saying so
first would be the kind of claim the commitment exists to forbid.

What keeps it consistent with the commitment is the shape of the honesty, not a softer description:

- **The scope is the channels you add it to**, which is a decision you make and can reverse.
- **What it holds and who it is sent to are named** in [`PRIVACY.md`](PRIVACY.md), against the code,
  including the subprocessors.
- **The source is public (AGPL-3.0)**, so the claim is checkable rather than trusted. Section 1.3 of
  the canonical copy makes auditability the enforcement mechanism, and a bot that reads chat is
  precisely the case where that matters.
- **The self-host route is real.** Run your own instance and you are the data controller for it.

## The tripwire

**If this instance ever retains content from channels it was not added to, sends content to a
subprocessor not named in `PRIVACY.md`, or uses message content for anything other than the feature
the user invoked, the commitment stops being true, and whoever ships it owns updating the canonical
document in the same PR.** See the canonical copy for the full set of drift tripwires.
