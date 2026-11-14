// ContractWorld backed by the loopback fake Gitea; the adapter under test
// talks to it over real HTTP.

import { GiteaForge } from "../../src/forge/gitea.ts";
import type { Forge, ReviewComment } from "../../src/forge/types.ts";
import { FAKE_TOKEN, FakeGitea } from "./fake-gitea.ts";
import {
	type ContractWorld,
	type SeedIssue,
	type SeedPullRequest,
	type SeedReview,
	type SeedStatus,
} from "./world.ts";

const REVIEW_EVENTS = { approved: "APPROVED", changes_requested: "REQUEST_CHANGES", commented: "COMMENT" } as const;

export class GiteaWorld implements ContractWorld {
	private constructor(
		readonly fake: FakeGitea,
		readonly forge: Forge,
	) {}

	static async create(opts: { withContentVersion: boolean; maxPageSize?: number }): Promise<GiteaWorld> {
		const fake = await FakeGitea.start(opts);
		const forge = new GiteaForge({
			baseUrl: fake.url,
			owner: "o",
			repo: "r",
			env: { GITEA_TOKEN: FAKE_TOKEN },
			teaConfigPath: "/nonexistent/tea.yml",
		});
		return new GiteaWorld(fake, forge);
	}

	async seedIssue(issue: SeedIssue = {}): Promise<number> {
		return this.fake.seedIssue(issue);
	}

	async editBodyBehindBack(n: number, body: string): Promise<void> {
		this.fake.editIssueBody(n, body);
	}

	async bodyOf(n: number): Promise<string> {
		return this.fake.issueBody(n);
	}

	async postComment(n: number, author: string, body: string): Promise<string> {
		return String(this.fake.seedComment(n, author, body));
	}

	async commentBodyOf(id: string): Promise<string> {
		return this.fake.commentBody(Number(id));
	}

	async hasLabel(name: string): Promise<boolean> {
		return this.fake.hasLabel(name);
	}

	async dropLabel(name: string): Promise<void> {
		this.fake.dropLabel(name);
	}

	async labelCreateCount(name: string): Promise<number> {
		return this.fake.labelCreates.get(name) ?? 0;
	}

	async seedPullRequest(pr: SeedPullRequest): Promise<number> {
		return this.fake.seedPull(pr);
	}

	async editPullRequestBodyBehindBack(n: number, body: string): Promise<void> {
		this.fake.editPullBody(n, body);
	}

	async seedReview(pr: number, review: SeedReview): Promise<void> {
		this.fake.seedReview(pr, { author: review.author, event: REVIEW_EVENTS[review.state], body: review.body });
	}

	async seedStatus(ref: string, status: SeedStatus): Promise<void> {
		this.fake.seedStatus(ref, { context: status.name, status: status.state, url: status.url });
	}

	async reviewCommentsOf(pr: number): Promise<ReviewComment[]> {
		return this.fake.reviewComments(pr);
	}

	async setPermission(login: string, level: "none" | "read" | "write" | "admin"): Promise<void> {
		this.fake.setPermission(login, level);
	}

	async makeUnreachable(): Promise<void> {
		this.fake.setUnreachable(true);
	}

	async restore(): Promise<void> {
		this.fake.setUnreachable(false);
	}

	async dispose(): Promise<void> {
		await this.fake.close();
	}
}
