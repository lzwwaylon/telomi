# Media Playback

## Responsibilities

Frontend Media Playback owns the global playback session for audio artifacts. Report cards and file previews only select audio. Navigation, closing a file preview, and expanding or collapsing the player neither create a new session nor stop audio.

## Interface and boundaries

The player has only two presentations: a bottom bar and a fully expanded player. The expanded player owns playback controls, chapters, and transcript reading; collapsing it restores the previous browsing view and its focus. Clicking a report first opens a file-preview dialog; only the dialog's full-screen reading button opens the reading route. Clicking an audio label only plays or pauses. Only the cover and title area on the bottom bar's left opens the full player. The bottom bar's close button stops playback and closes the player. The expanded player offers collapse at the top right, with view-original-report, download-audio, and stop-and-close actions grouped in the overflow menu; transcript mode retains the same entry. The report preview's file list and previous/next navigation exclude internal files marked as non-publication artifacts. The player uses report cover thumbnails and the shared application logo, with the report-cover fallback image on load failure.

`PlayerProvider` supplies playback, seeking, preferences, expansion state, and temporary pause leases. `GlobalAudioElement` is the sole playback element for audio artifacts and owns media events and system media-control integration. Presentation components do not create audio elements. Voice input temporarily yields audio through the existing pause lease; releasing it cannot override the user's subsequent pause, track change, or decision to stop listening.

Shared Artifact Preview does not depend on the Media Feature. Callers inject Media-owned audio UI through `renderAudio`; Chat Workspace and Goal file previews use the same implementation.

## State and recovery

Playback and presentation state are independent. Refresh restores only a paused session, without autoplay or opening the full player. Stopping listening hides the player but retains that audio's progress and playback preferences. Finishing retains completion state, and playing again starts at the beginning. A regenerated podcast has a new source version and cannot reuse the previous version's resume position.

Resume records stay in the current browser, retaining at most the 30 most recent audio sources. Persisted state is validated on read, and only the current format is restored. Older snapshots are not migrated; unversioned records cannot resume versioned artifacts. This mechanism does not own cross-device synchronization, research notes, or User Memory.

Transcripts use only the URL explicitly supplied by the audio item; it is not inferred from old snapshots or media state. Transcript requests are cancelled when the source changes, and failures do not interrupt audio playback. Seeking uses server-provided paragraph time boundaries; it neither generates a new transcript nor promises word-level alignment. Manual scrolling can pause following, and users can return to the current paragraph.

The sleep timer uses an actual clock deadline, then pauses and saves progress. Background pages are subject to browser scheduling limits and recheck the deadline when visible again; execution of page code during operating-system suspension is not guaranteed.
