// Imports
const fs = require('fs');
const path = require('path');

// IMPORTANT VARIABLES
const logs = 'log.txt'; // This is where all logs are stored.
const ok = "[OK]";
const warn = '[WARN]';
const error = '[ERROR]';
const jojoURL = 'https://jojowiki.com/api.php?';
// Functions

//// LOG Functions
function printOK(text) {
    fs.appendFileSync(logs, `${ok} ${text}\n`);
}
function printWarn(text) {
    fs.appendFileSync(logs, `${warn} ${text}\n`);
}
function printError(text) {
    fs.appendFileSync(logs, `${error} ${text}\n`);
}

//// JSON Functions
function makeJojoID(name, part) {
    // Formats rawID to all lowercase and replaces any special character with '-'
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `${id}-p${part}`;
}


//// Convert jjba_characters.txt -> entries
function createJojoEntries(text) {
    const entries = [];
    const lines = text.split('\n'); // Splits characters.txt into an array, each line is a new element of the array.
    let part = 0; // Season
    /// Check for empty lines / Season indicator
    for (const rawLine of lines) {
        const line = rawLine.trim(); // Trim out the invisible noise
        if(line === '') {
            continue; // Skip line if empty
        }
        if(line.startsWith('#')) { // # is the part indicator (New season)
            const partText = line.split(' '); // Split the line into chunks
            part = Number(partText.at(-1)); // Take the number at the end of the line and update part to reflect that number.
            continue; // Do NOT make the part declarator an entry
        }

        // rawName = unformatted name of character. rawOverride = unformatted custom image.
        const [rawName, rawOverride] = line.split('|'); // Overrides should be separated from the name with a '|' symbol.
        const name = rawName.trim(); // Trim any invisible characters after the separation of '|'
        const override = rawOverride?.trim(); // Not every character has an image override, the ? prevents errors from undef overrides.
        const id = makeJojoID(name, part);

        // Store information in JSON format.
        entries.push({id,   name,   part,   override});
    }
    return entries;
}

//// Duplicate Protection
function checkDuplicates(entries) {
    const seen = new Set();
    for(const entry of entries) {
        if(seen.has(entry.id)) {
            printError(`${entry.id} already exists!`);
            process.exit(1);
        }
        seen.add(entry.id);
    }
    printOK("No Duplicates Found!");
}

// QUERY FUNCTIONS

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

//// Wiki Image Lookup
async function lookupJojoImage(entry){
    // What do we look up
    const params = new URLSearchParams({
        action: 'query',
        titles: entry.name,
        prop: 'images',
        imlimit: 'max',
        redirects: '1',
        format: 'json',
    });
    // Wait for a response from the website with params
    const response = await fetch(`${jojoURL}${params}`, {
        headers: {
            'User-Agent': 'Guess Who (Fan Project)'
        }
    })
    // Collect the data
    const data = await response.json();
    const page = Object.values(data.query.pages)[0];

    if(page.missing !== undefined) {
        return {status: 'missing page'};
    }

    const images = page.images ?? []; // Collect images on the page

    let matches = images.filter(img => /infobox anime/i.test(img.title)); // Filter by image URL containing infobox anime
    if(matches.length === 0) {
        matches = images.filter(img => /infobox manga/i.test(img.title)); // Filter for manga images

        if(matches.length === 0) {
            matches = images.filter(img => img.title.toLowerCase().includes(entry.name.toLowerCase())); // If all else fails, try to find image by character name
        }
    }

    if(matches.length > 0) {
        return {status: 'ok', title: matches[0].title} // Found image
    }
    return {status: 'none'}; // Did not find image

}

// Collects image data for entries, also checks if there were problems getting images
async function checkWikiStatus(entries) {
    const problems = [];

    // If we have an override for the image, just use that and DO NOT look up for the image.
    for(const entry of entries) {
        if(entry.override) {
            entry.imageFile = entry.override;
            continue;
        }

        const result = await lookupJojoImage(entry);
        if(result.status === 'ok') {
            printOK(`${entry.id} wiki page found! Fetching image url...`)
        }
        if(result.status === 'missing page') {
            problems.push(entry.id);
            printWarn(`${entry.id} wiki page not found!`);
        }
        if(result.status === 'none') {
            problems.push(entry.id);
            printWarn(`${entry.id} image not found!`);
        }

        entry.imageFile = result.title;

        await sleep(200);
    }
    if(problems.length > 0) {
        printWarn(`${problems.length} problems found`);
    }
    else {
        printOK("Found all wiki pages and images!")
    }

    const noImage = entries.filter(e => !e.imageFile);
    if(noImage.length > 0) {
        printError("Entries with no image detected");
    }
    else{
        printOK("Found all images successfully!");

    }
}

//// Fetches the image URL from the file name
async function resolveUrls(batch) {
    const params = new URLSearchParams({
        action: 'query',
        titles: batch.map(e => e.imageFile).join('|'),
        prop: 'imageinfo', // IMPORTANT: this is what gives us the url
        iiprop: 'url',
        iiurlwidth: '300',
        format: 'json',
    });

    const response = await fetch(`${jojoURL}${params}`, {
        headers: {
            'User-Agent': 'Guess Who (Fan Project)'
        }
    });

    const data = await response.json();
    const urlByTitle = {};

    for (const page of Object.values(data.query.pages)) {
        urlByTitle[page.title] = page.imageinfo?.[0]?.thumburl;
    }

    for (const n of data.query.normalized ?? []) {
        urlByTitle[n.from] = urlByTitle[n.to];
    }

    for(const entry of batch) {
        entry.thumburl = urlByTitle[entry.imageFile];

        if(!entry.thumburl) {
            printError(`${entry.id}: no URL for ${entry.imageFile}`);
        }
        else{
            printOK(`${entry.id}: URL resolved`);
        }
    }
}

////
async function downloadImage(entry) {
    const response = await fetch(entry.thumburl, {
        headers: {
            'User-Agent': 'Guess Who (Fan Project)'
        }
    });

    if(!response.ok) {
        printError(`${entry.id} ${response.status}`);
        return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = path.extname(new URL(entry.thumburl).pathname).toLowerCase();
    const filePath = `images/${entry.id}${ext}`;
    fs.writeFileSync(filePath, buffer);

    entry.image = filePath;
    printOK(`${entry.id}: saved to ${filePath}`);


}

// MAIN
async function main() {
    fs.writeFileSync(logs, "");

    const jojoCharacters = fs.readFileSync('jjba_characters.txt', 'utf8');
    const jojoEntries = createJojoEntries(jojoCharacters);
    // Check for duplicates
    checkDuplicates(jojoEntries);

    // Wiki Confirmation
    await checkWikiStatus(jojoEntries);

    for (let i = 0; i < jojoEntries.length; i += 50) {
        const batch = jojoEntries.slice(i, i + 50);
        await resolveUrls(batch);

        await sleep(200);
    }

    fs.mkdirSync('images', {recursive: true});
    for(const entry of jojoEntries) {
        await downloadImage(entry);
        await sleep(150);
    }

    const output = jojoEntries.map(({ id, name, part, image }) => ({ id, name, part, image}));


    // Add all entries into a JSON file
    fs.writeFileSync('jjba_characters.json', JSON.stringify(output, null, 2));
    printOK(`Wrote ${output.length} characters to jjba_characters.json`);

}

main();