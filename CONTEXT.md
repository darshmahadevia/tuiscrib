# Tuiscrib

Tuiscrib is a terminal-based collaborative sticky-note editor. It gives small groups a durable shared surface while propagating changes live to connected members.

## Language

**Tuiscrib Service**:
The single hosted environment that holds the authoritative users, boards, and live collaboration state.
_Avoid_: Server, instance, network

**Source-First Portfolio Demo**:
The source checkout is Tuiscrib's distribution surface for now. Users clone the repository, run the Bun terminal client, and connect to the hosted Tuiscrib Service by default; the hosted path is a best-effort demonstration for evaluators and small technical teams using non-sensitive collaboration data, with no production availability, backup, support, or recovery guarantee.
_Avoid_: production service, startup beta, general availability

**Board**:
A named freeform canvas of sticky notes that forms the boundary of collaboration.
_Avoid_: Workspace, wall, collection

**Sticky Note**:
A board contribution consisting of bounded multiline Unicode plain text, a decorative color, authorship, and a position.
_Avoid_: Card, item, document

**User-perceived Unicode character**:
One Unicode extended grapheme cluster segmented by `Intl.Segmenter("und", { granularity: "grapheme" })`; the shared contracts fail closed when that runtime is unavailable.
_Avoid_: Code point, UTF-16 unit

**Color**:
A member-selected decorative property shared by every viewer of a sticky note; it carries no service-defined meaning.
_Avoid_: Label, category, local theme

**Position**:
A sticky note's location in a board's shared coordinate plane.
_Avoid_: Slot, cell, placement

**Stacking Order**:
The front-to-back relationship among sticky notes whose footprints overlap on a board.
_Avoid_: Layer, z-index

**Authorship**:
Durable attribution of a sticky note to the user who created it; it does not give that user exclusive authority over the note.
_Avoid_: Ownership, creator rights

**Last Edit**:
Attribution of a sticky note's current text to the member who most recently changed it and the time of that change.
_Avoid_: Revision, edit history

**User**:
A person with a persistent service-wide identity and a unique, immutable username.
_Avoid_: Account, guest, anonymous user

**Terminal Session**:
One terminal client's authenticated access to a user identity.
_Avoid_: Login, connection, token

**Join Code**:
The board's single reusable secret that a user redeems to gain membership.
_Avoid_: Invite, board password, share link

**Membership**:
A relationship granting a user access to a board until the user leaves or the board is deleted.
_Avoid_: Access, enrollment

**Member**:
A user with membership in a board. Every member may collaborate on sticky notes, and exactly one member is the owner.
_Avoid_: Collaborator, participant, editor

**Owner**:
The single member who may rename a board, rotate its join code, or delete it in addition to ordinary collaboration. The owner cannot leave the board.
_Avoid_: Administrator, creator

**Edit Claim**:
A temporary exclusive right held by one terminal session to change a sticky note's text or delete it; position, stacking order, and color remain independently changeable.
_Avoid_: Lock, checkout

**Presence**:
A member's transient status while connected to a board.
_Avoid_: Online status, cursor
