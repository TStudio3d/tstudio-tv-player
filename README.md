# tstudio-tv-player

Static hosting for the TStudio TV in-world screen page. YouTube and Twitch embeds need a real web origin
(referer / Twitch `parent`), which the in-game `nui://` page cannot provide, so the resource opens this
copy of the same page in its hidden screen browser when a link is played.

- Static files only. No backend, no storage, no analytics. Nothing is shared between servers or players.
- Each release publishes the page under a versioned path (`/v1/`), so an update never changes a shipped version.
- Server owners can self-host the same files (`html/dui.*` of the resource) and point `Config.Media.playerUrl` at them.
