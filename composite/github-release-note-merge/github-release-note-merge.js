const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const RELEASE_TAG = process.env.RELEASE_TAG;

const SOURCE_REPOS = [
    {
        owner: 'kestra-io',
        repo: 'kestra',
        title: 'Kestra Open-Source Edition Changes'
    },
    {
        owner: 'kestra-io',
        repo: 'kestra-ee',
        title: 'Kestra Enterprise Edition Changes'
    }
];

const TARGET_REPO_CONFIG = {
    owner: 'kestra-io',
    repo: 'kestra'
};


async function githubApiRequest(endpoint, options = {}) {
    const url = `https://api.github.com${endpoint}`;
    const headers = {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`GitHub API request failed for ${url}: ${response.status} ${response.statusText}\n${errorBody}`);
    }

    if (response.status >= 200 && response.status < 300 && response.headers.get("content-length") !== "0") {
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            return response.json();
        }
    }

    return {};
}

async function getMergedChangelog() {
    console.log(`Fetching release notes for tag: ${RELEASE_TAG}`);

    let allReleasesFound = true;

    const releaseNotePromises = SOURCE_REPOS.map(async ({ owner, repo, title }) => {
        try {
            const endpoint = `/repos/${owner}/${repo}/releases/tags/${RELEASE_TAG}`;
            const release = await githubApiRequest(endpoint);
            console.log(`Successfully fetched release notes from ${owner}/${repo}.`);
            // Format the body with a title.
            return `## ${title}\n\n${release.body}`;
        } catch (error) {
            // Check if the error is a 404 Not Found, which means the release doesn't exist.
            if (error.message && error.message.includes('404 Not Found')) {
                console.error(`Release '${RELEASE_TAG}' for ${owner}/${repo} was not found. Halting script.`);
                allReleasesFound = false;
            } else {
                console.error(`Failed to fetch release notes from ${owner}/${repo}:`, error.message);
            }
            return null; // Return null on failure
        }
    });

    const releaseNotes = await Promise.all(releaseNotePromises);

    // If any release was not found, return null to signal main function to stop.
    if (!allReleasesFound) {
        return null;
    }

    const mergedMarkdown = releaseNotes
        .filter(note => note !== null)
        .join('\n\n---\n\n');

    return mergedMarkdown;
}


async function updateReleaseNotes(content) {
    const { owner, repo } = TARGET_REPO_CONFIG;
    const getReleaseEndpoint = `/repos/${owner}/${repo}/releases/tags/${RELEASE_TAG}`;

    try {
        console.log(`Getting release info for tag ${RELEASE_TAG} in ${owner}/${repo}...`);
        const release = await githubApiRequest(getReleaseEndpoint);
        const releaseId = release.id;

        if (!releaseId) {
            throw new Error(`Could not find a release with tag ${RELEASE_TAG} in ${owner}/${repo}.`);
        }

        const updateReleaseEndpoint = `/repos/${owner}/${repo}/releases/${releaseId}`;

        console.log(`Updating release notes for release ID ${releaseId}...`);
        await githubApiRequest(updateReleaseEndpoint, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                body: content,
            }),
        });

        console.log('Release notes updated successfully!');
        console.log(`View the updated release at: ${release.html_url}`);

    } catch (error) {
        console.error(`Error updating release notes for tag ${RELEASE_TAG}:`, error.message);
    }
}


async function main() {
    if (!GITHUB_TOKEN) {
        console.error('Error: GitHub token is not set. Please set the GITHUB_TOKEN environment variable.');
        return;
    }

    if (!RELEASE_TAG) {
        console.error('Error: Release tag is not set. Please set the RELEASE_TAG environment variable.');
        return;
    }

    try {
        const mergedChangelog = await getMergedChangelog();

        if (mergedChangelog) {
            await updateReleaseNotes(mergedChangelog);

        } else {
            console.log('No release notes were fetched. Halting execution.');
        }
    } catch (error) {
        console.error('An unexpected error occurred:', error.message);
    }
}

console.log("Starting release notes update...");
main();
