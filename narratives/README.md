# Narrative Builder

A mad-lib and rubric builder for student narratives (reading, writing, class participation; under 200 words), saving to a Google Doc through Apps Script and filling Veracross through a bookmarklet. Use it at **https://jake-goldwasser.com/narratives/** (short link: **jake-goldwasser.com/nb**, a redirect in `nb/`); there it saves in the browser only (`noindex`, not in the nav).

Files: `src/index.html` (edit this), `index.html` (built by `node narratives/build.js`, which puts `veracross-filler.js` in as the bookmarklet; paste it into Apps Script as `Index`), `Code.gs` (Apps Script), `veracross-filler.js`.

## Setup (about 5 minutes, one time)

## 1. Connect it to your Google Doc
1. Create a new Google Doc for this term's narratives (for example, "Narratives – Fall 2026").
2. In the doc, go to **Extensions → Apps Script**.
3. Delete what's in `Code.gs` and paste in the contents of **Code.gs**.
4. Click **＋ → HTML**, name the file `Index` (no extension), and paste in the contents of **index.html** from this folder.
5. Click **Save** 💾 and close the Apps Script tab.
6. Reload the doc. A **Narratives** menu appears. Choose **Narratives → Open Narrative Builder**.
7. The first time, Google asks you to authorize the script. Choose your account, then **Advanced → Go to (project) → Allow**. It's your own script and only touches this doc.

Every change saves automatically, about 2 seconds after you stop typing (the top bar reads "Saved to Google Doc · 8:42 AM"). The doc is rewritten each time with every student's heading, narrative and word count. Make your edits in the builder: anything typed directly into the doc gets overwritten.

**Optional, for a full browser tab instead of a pop-up window:** in Apps Script choose **Deploy → New deployment → Web app**. Set Execute as **Me** and Who has access **Only myself**, then bookmark the URL. Open the builder from the doc menu once first so it knows which doc to use.

## 2. Add students
Copy the name column from your Google Sheet, plus the grade and pronoun columns if you have them. Click **Paste roster**. The tool:
- detects header rows and grade/pronoun columns, and accepts "Last, First"
- for separate first and last name columns, lets you say which order they're in
- shows a preview, and skips names that are already in the list

## 3. Write
- **Only what you mark goes in.** Each rubric row you mark (Exceptionally well / Proficient / Room for growth) adds its own sentence, in the order of the rows; its dropdown swaps the wording, offers next steps, or lets you write your own. A row you don't mark, a dropdown left on “— leave out —” and an empty box add nothing. A sentence you picked or wrote yourself stays put if you change that row's level.
- **Clearing:** every question has a × (or “— leave out —”), and **Clear sheet** (click twice) clears everything for the student.
- **Too long?** Past 200 words the meter turns red and a note says how far over; nothing is ever cut for you.
- **Sections:** Opening, Reading, Writing, Class Participation, Student Writing (grade 9; its own paragraph in the narrative) and Closing.
- Each blank is a dropdown of phrases based on your Class Participation Rubric, your FLE rubrics and the English 9 syllabus. Choose **✎ write my own…** to type your own words, or **— leave out —** to drop an optional sentence.
- Each section has a box at the bottom for adding your own sentence.
- **Grade 9:** the Writing section has a bar where you can quote a line of the student's writing or name the subject of a creative piece (poem, personal essay, short story…).
- Changing the name, grade or pronouns updates the whole narrative, including verbs ("she brings" / "they bring").
- The word meter turns red past 200. Roster dots: grey = not started, amber = has blanks, green = finished, red = over 200 words.
- Use **Edit by hand** for final polishing. Use **Back to builder** to throw away the hand edits and return to the dropdowns.

## 4. Send to Veracross
1. Click **Send to Veracross**. The first time, drag the **Fill Veracross** button to your bookmarks bar.
2. Click **Copy narratives**.
3. In Veracross, open the comment-entry page for the class and click the **Fill Veracross** bookmark. It finds each student's comment box by name, fills it in and outlines it in green. It also lists any students it couldn't match.
4. Look the comments over, then click **Save** in Veracross.

The filler doesn't press Save for you. If you want it to, open `veracross-filler.js`, set `AUTO_SAVE = true`, and paste the file into the browser console (or rebuild the bookmarklet).
