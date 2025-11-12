import * as fs from 'fs';
import * as core from "@actions/core";
import * as github from "@actions/github";
import nunjucks from "nunjucks";
import {humanReadableDate, humanReadableSize} from "./nunjucks-helpers.js";
import {GitHub} from "@actions/github/lib/utils.js";

const MARKER = '<!-- KESTRA-ACTIONS-UPDATES -->'

class CommentUpdate {
    private octokit: InstanceType<typeof GitHub>;
    private readonly title: string;
    private readonly titleHash: string;
    private readonly template: string;
    private readonly fetchArtifact: boolean;
    private readonly addSummary: boolean;
    private readonly files: string[];
    private readonly nunjucks: nunjucks.Environment;
    private readonly owner: string;
    private readonly repo: string;
    private readonly prId: number;
    private readonly fetchUnreleasedCommits: boolean;

    constructor() {
        this.octokit = github.getOctokit(core.getInput('github-token'));
        this.title = core.getInput('title');
        this.titleHash = this._simpleHash(this.title);
        this.template = core.getInput('template');
        this.fetchArtifact = core.getBooleanInput('fetch-artifact');
        this.addSummary = core.getBooleanInput('add-summary');
        this.files = core.getMultilineInput('files');
        this.fetchUnreleasedCommits = core.getBooleanInput('fetch-unreleased-commits');

        this.nunjucks = new nunjucks.Environment();
        this.nunjucks
            .addFilter('prettyDate', humanReadableDate)
            .addFilter('prettySize', humanReadableSize)

        this.owner = github.context.payload.repository?.owner.login as string;
        this.repo = github.context.payload.repository?.name as string;
        this.prId = github.context.payload.pull_request?.number as number;
    }

    async _fetchArtifact(): Promise<any> {
        const result = await this.octokit.rest.actions
            .listWorkflowRunArtifacts({
                owner: this.owner,
                repo: this.repo,
                run_id: github.context.runId
            })

        if (result.data.total_count === 0) {
            core.warning(`No artifacts found`)
        } else {
            core.debug(`Found ${result.data.total_count} artifacts`)
        }

        if (!result?.data?.artifacts) {
            return []
        }

        return result
            .data
            .artifacts
            .map((i) => {
                return ({...i, ...{
                        download_url: 'https://github.com/' + this.owner + '/' + this.repo + '/actions/runs/' + github.context.runId + '/artifacts/' + i.id
                    }});
            });
    }

    async _buildData() {
        let data: Record<any, any> = {...github.context, ...{}}

        if (this.fetchArtifact) {
           data = {...data, ...{artifacts: await this._fetchArtifact()}};
        }

        if (this.files) {
            data["files"] = [];
            for (const [index, file] of this.files.entries()) {
                const current = JSON.parse(fs.readFileSync(file, { encoding: 'utf8', flag: 'r' }));
                data["files"][index] = current;
            }
        }

        if (this.fetchUnreleasedCommits) {
            const unreleased = await this._fetchUnreleasedCommits();
            data["unreleased"] = unreleased;
            core.info(`Included ${unreleased.commits.length} unreleased commits since ${unreleased.latestTag}`);
        }

        data["owner"] = this.owner;
        data["repo"] = this.repo;
        data["github"] = {
            repository: `${this.owner}/${this.repo}`,
        };

        core.debug(`Generated data:\n${JSON.stringify(data, undefined, 2)}`);

        return data;
    }

    async _findComment() {
        const comments: any[] = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
            owner: this.owner,
            repo: this.repo,
            issue_number: this.prId
        })

        core.debug(`Found ${comments.length} comments`)

        const filter = comments
            .filter(comment => comment.body.includes(MARKER));

        return filter.length > 0 ? filter[0] : null;
    }

    _simpleHash(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = (hash << 5) - hash + char;
        }

        return (hash >>> 0).toString(36).padStart(7, '0');
    };

    _sectionContent(content: string): string {
        let section = `## ${this.title}\n\n${content}\n`

        if (content.trim().length == 0) {
            section = "";
        }

        return `<!-- ${this.titleHash} -->\n${section}<!-- /${this.titleHash} -->`;
    }

    async _addComment(content: string): Promise<void> {
        let comment: any = await this._findComment()

        if (comment === null) {
            core.debug(`Comment not found, creating a new one`)

            comment  = await this.octokit.rest.issues.createComment({
                owner: this.owner,
                repo: this.repo,
                issue_number: this.prId,
                body: `${MARKER}\n${this._sectionContent(content)}`
            });
        } else {
            core.debug(`Comment found, updating it`)

            const regExp = new RegExp(`<!-- ${this.titleHash} -->(.*?)<!-- \\/${this.titleHash} -->`, 'gs')
            let commentContent: string = comment.body.replace(MARKER, '').trim();

            if (commentContent.match(regExp)) {
                core.debug(`Section found, updating it`)

                commentContent = commentContent.replaceAll(regExp, this._sectionContent(content));
            } else {
                core.debug(`Section not found, creating a new one`)

                commentContent = `${commentContent}\n\n${this._sectionContent(content)}`
            }

            comment = await this.octokit.rest.issues.updateComment({
                owner: this.owner,
                repo: this.repo,
                comment_id: comment.id,
                body: `${MARKER}\n${commentContent}`
            });
        }

        core.debug(`Comment added/updated: ${comment.data.html_url}`)

        return comment;
    }

    async _renderTemplate(data: any) {
        const s: string = this.nunjucks.renderString(this.template, data);

        core.debug(`Rendered template :\n${s}`)

        return s
    }

    async run(): Promise<void> {
        const data = await this._buildData();
        const renderer: string = await this._renderTemplate(data);

        await this._addComment(renderer);

        if (this.addSummary && renderer.trim() !== '') {
            let section = `## ${this.title}\n\n${renderer}\n`
            core.summary.addRaw(section, true).write();
        }
    }

    async _fetchUnreleasedCommits(): Promise<{ latestTag: string; commits: any[] }> {
        let latestTag: string | null = null;
        try {
            const owner = this.owner;
            const repo = this.repo;

            try {
                const release = await this.octokit.rest.repos.getLatestRelease({ owner, repo });
                latestTag = release.data.tag_name ?? null;
                core.debug(`Latest release tag: ${latestTag}`);
            } catch {
                const tags = await this.octokit.rest.repos.listTags({ owner, repo, per_page: 20 });
                if (tags.data.length > 0) {
                    latestTag = tags.data[0].name ?? null;
                }
            }

            if (!latestTag) {
                core.debug(`No tags or releases found in repository`);
                return { latestTag: "unknown", commits: [] };
            }

            let defaultBranch = "main";
            try {
                const repoInfo = await this.octokit.rest.repos.get({ owner, repo });
                defaultBranch = repoInfo.data.default_branch ?? "main";
            } catch {
                core.debug(`Could not determine default branch, using 'main'`);
            }

            let compare: any | null = null;
            try {
                compare = await this.octokit.rest.repos.compareCommits({
                    owner,
                    repo,
                    base: `refs/tags/${latestTag}`,
                    head: defaultBranch,
                });

                if (!compare?.data?.commits?.length) {
                    compare = await this.octokit.rest.repos.compareCommits({
                        owner,
                        repo,
                        base: latestTag,
                        head: defaultBranch,
                    });
                }
            } catch (e) {
                // try fallback branch if initial compare failed
                if (defaultBranch === 'main') {
                    try {
                        compare = await this.octokit.rest.repos.compareCommits({
                            owner,
                            repo,
                            base: latestTag,
                            head: 'master',
                        });
                    } catch (e2) {
                        return { latestTag: latestTag ?? "unknown", commits: [] };
                    }
                } else {
                    return { latestTag: latestTag ?? "unknown", commits: [] };
                }
            }

            if (!compare?.data?.commits) {
                return { latestTag, commits: [] };
            }

            const commits = compare.data.commits
                .filter((c: any) => {
                    const msg = (c.commit?.message ?? '').trim().toLowerCase();
                    return !(
                        msg.startsWith('chore(version): bump to') ||
                        msg.startsWith('chore(version): update snapshot') ||
                        msg.startsWith('chore(version): update to version')
                    );
                })
                .map((c: any) => ({
                    sha: c.sha,
                    message: c.commit?.message?.split('\n')[0],
                    author: c.commit?.author?.name ?? c.author?.login ?? 'unknown',
                    date: c.commit?.author?.date ?? c.commit?.committer?.date,
                }));

            core.debug(`Found ${commits.length} unreleased commits since ${latestTag}`);

            return { latestTag, commits };
        } catch (e) {
            return { latestTag: latestTag ?? "unknown", commits: [] };
        }
    }
}

try {
    const commentUpdate: CommentUpdate = new CommentUpdate();
    await commentUpdate.run();
} catch (error: any) {
    core.setFailed((error as Error).message);
}
