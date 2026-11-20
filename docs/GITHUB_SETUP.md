# GitHub setup for the API docs automation

This guide sets up the two GitHub Actions workflows that keep `docs/openapi.yaml` in sync with the code. Follow the sections in order. Each one takes a few minutes.

## 1. What gets set up and why

**docs-check** runs on every pull request to `main` and fails when the API docs are out of date or do not lint, so stale docs cannot be merged. **/regen-docs** lets a maintainer comment `/regen-docs` on a pull request to have GitHub regenerate the docs with Gemini and push them to the pull request's branch.

You will create:

- [ ] One Actions setting checked: Actions enabled, default `GITHUB_TOKEN` permission read-only
- [ ] A fine-grained personal access token with write access to this repository's contents
- [ ] Repository secret `GEMINI_API_KEY`
- [ ] Repository secret `DOCS_BOT_TOKEN`
- [ ] Label `skip-api-docs`
- [ ] One test pull request, so `docs-check` runs once
- [ ] A ruleset for `main` that requires a pull request and the `docs-check` check

## 2. Before you start

You need:

1. **Admin access to this repository.** Open the repository on GitHub. If you can see the **Settings** tab, you have it.
2. **A Gemini API key.** Get one at [Google AI Studio](https://aistudio.google.com/apikey): sign in with a Google account and click **Create API key**. Copy the key somewhere safe for now; you will paste it in section 5.
3. **The workflow files merged into `main`.** Check that both of these exist on the `main` branch on GitHub:
   - `.github/workflows/docs-check.yml`
   - `.github/workflows/regen-docs.yml`

   `/regen-docs` is triggered by a comment, and GitHub only runs comment-triggered workflows from the default branch. If the file is only on another branch, the command does nothing.
4. **`main` set as the default branch.** Go to **Settings → General**, and under **Default branch** check that it says `main`.

## 3. Check the Actions settings

1. Go to **Settings → Actions → General**.
2. Under **Actions permissions**, select **Allow all actions and reusable workflows**.
   If your organisation requires a stricter option, choose **Allow \<owner\>, and select non-\<owner\>, actions and reusable workflows** and tick **Allow actions created by GitHub**. The workflows only use actions published by GitHub (`actions/checkout`, `actions/setup-node`, `actions/github-script`).
3. Scroll to **Workflow permissions** and select **Read repository contents and packages permissions**.
   Leave it read-only. Each workflow asks for the extra permissions it needs (for example, writing pull request comments) in its own file, so nothing else gets write access by default.
4. Leave **Allow GitHub Actions to create and approve pull requests** unticked.
5. Click **Save** under the section you changed.

## 4. Create the DOCS_BOT_TOKEN fine-grained token

`/regen-docs` pushes the regenerated docs with this token instead of the built-in `GITHUB_TOKEN`. GitHub does not start new workflow runs for pushes made with `GITHUB_TOKEN`, so this is what makes `docs-check` run again on the new commit.

1. Click your profile picture (top right) and go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
2. Click **Generate new token**.
3. Fill in the form:
   - **Token name:** `api-docs-ai DOCS_BOT_TOKEN`
   - **Description:** `Pushes regenerated API docs from the regen-docs workflow`
   - **Resource owner:** the account or organisation that owns this repository.
   - **Expiration:** pick a date, for example 90 days from today. Put a reminder in your calendar to replace the token before then (see the end of this section).
   - **Repository access:** select **Only select repositories**, then choose this repository (`api-docs-ai`) from the list.
4. Under **Permissions → Repository permissions**, find **Contents** and set it to **Read and write**.
   **Metadata** switches to **Read-only** on its own. Leave every other permission at **No access**.
5. Click **Generate token**, then copy the token. It starts with `github_pat_`. GitHub shows it only once; if you lose it, generate a new one.

> **Do not choose "Public repositories" under Repository access.** That option is read-only, so the token can read the repository but every push fails with a `403` error.
>
> If you cannot use a fine-grained token (for example, your organisation blocks them), create a classic token instead under **Personal access tokens → Tokens (classic)** with the **`repo`** scope. It works the same way but has access to every repository you can push to.

If the repository belongs to an organisation, the organisation may need to approve the token before it works. If it shows as **Pending**, ask an organisation owner to approve it under the organisation's **Settings → Personal access tokens → Pending requests**.

**When the token expires**, `/regen-docs` fails at the **Commit and push** step. Generate a new token with the same settings and replace the `DOCS_BOT_TOKEN` secret (section 5, step 5).

## 5. Add the repository secrets

1. Go to the repository's **Settings → Secrets and variables → Actions**.
2. Stay on the **Secrets** tab and click **New repository secret**.
3. Add the Gemini key:
   - **Name:** `GEMINI_API_KEY`
   - **Secret:** `<your-gemini-key>`
   - Click **Add secret**.
4. Click **New repository secret** again and add the token:
   - **Name:** `DOCS_BOT_TOKEN`
   - **Secret:** `<your-fine-grained-token>`
   - Click **Add secret**.
5. To replace a secret later, click the pencil icon next to it, paste the new value and click **Update secret**.

Paste each value exactly as it was given to you: no quotes around it, and no spaces or line breaks before or after it. The names are case-sensitive and must match exactly.

## 6. Create the skip-api-docs label

A pull request with this label passes `docs-check` without checking the docs. Use it for pull requests that touch the API code but should not change the docs, such as a refactor.

1. Go to the repository's **Issues** tab (or **Pull requests**) and click **Labels**.
2. Click **New label**.
3. Fill in:
   - **Label name:** `skip-api-docs`
   - **Description:** `docs-check passes without checking the API docs`
   - **Color:** any.
4. Click **Create label**.

## 7. Open a test pull request

GitHub only offers a status check in the ruleset (section 8) after that check has run at least once in the repository. This step makes `docs-check` run.

1. On GitHub, go to the **Code** tab, open `src/routes/health.js`, and click the pencil icon (**Edit this file**).
2. Add this line at the end of the file:
   ```js
   // Test change for the docs-check setup.
   ```
3. Click **Commit changes…**, select **Create a new branch for this commit and start a pull request**, name the branch `test-docs-check`, and click **Propose changes**.
4. Click **Create pull request**.
5. Wait for the checks at the bottom of the pull request to finish. You should see **docs-check** in the list.

   It will most likely **fail**, with "API docs are out of date" in its summary. That is expected: any change to a file in `src/routes/` changes what the docs are generated from. What matters here is that it ran.
6. Optional, to test `/regen-docs` as well: add a comment on the pull request containing only `/regen-docs`.
   - A 👀 reaction appears on your comment when the workflow starts.
   - When it finishes (usually a few minutes), the workflow replies with the result and pushes a commit called `docs: regenerate OpenAPI spec` to the branch.
   - `docs-check` then runs again on that commit and should pass.
   - If it replies with an error, open the link in the reply to see which step failed. A failure at **Commit and push** usually means the `DOCS_BOT_TOKEN` setup in section 4 is wrong.
7. Close the pull request without merging and delete the `test-docs-check` branch (the **Delete branch** button appears after closing).

## 8. Protect main with a ruleset

1. Go to **Settings → Rules → Rulesets**.
2. Click **New ruleset → New branch ruleset**.
3. Fill in the top of the form:
   - **Ruleset Name:** `main`
   - **Enforcement status:** **Active**
4. Under **Target branches**, click **Add target → Include default branch**.
5. Under **Rules**, tick **Require a pull request before merging**. Leave its extra options at their defaults unless your team wants required reviews.
6. Tick **Require status checks to pass**, then:
   - Click **Add checks**, type `docs-check`, and select it. If GitHub asks for a source, choose **GitHub Actions**.
   - If `docs-check` does not appear, section 7 has not completed yet. Wait until the check shows on the test pull request, then try again.
7. Click **Create**.

From now on, every pull request into `main` needs `docs-check` to pass before it can be merged. When it fails, the job summary lists the out-of-date operations. Fix it by running `npm run docs:generate` locally and pushing the result, or by asking a maintainer to comment `/regen-docs`.
