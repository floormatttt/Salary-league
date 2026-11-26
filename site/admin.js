/* Commissioner writes: every edit is a commit to data/*.json in the GitHub repo.
 *
 * Sign-in is a GitHub token (fine-grained, this repo only, Contents: read & write,
 * Actions: read & write for "Run sync now"). It's kept in this browser's
 * localStorage until "Sign out".
 *
 * Admin.apply([[mutation, arg], ...]) reads the latest data straight from
 * GitHub, runs the shared Mutations on it, adds an Admin Log entry and commits
 * every changed file in ONE commit. If the sync (or another commissioner)
 * committed in between, it starts over on the new data (up to 4 tries).
 */
var Admin = (function () {
  var API = "https://api.github.com";
  var KEYS = ["contracts", "holds", "cash", "teams", "adminLog"];
  var token = null, who = "";
  try { token = localStorage.getItem("slToken"); who = localStorage.getItem("slWho") || ""; } catch (e) {}

  function repoPath(p) { return "/repos/" + SITE.owner + "/" + SITE.repo + p; }
  function req(method, path, body, accept) {
    return fetch(API + path, {
      method: method, cache: "no-store",
      headers: { Authorization: "Bearer " + token, Accept: accept || "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (r.status === 401) throw new Error("GitHub didn't accept that token (it may have expired). Sign in again.");
      if (!r.ok) return r.text().then(function (t) {
        var msg = ""; try { msg = JSON.parse(t).message; } catch (e) {}
        var err = new Error("GitHub said " + r.status + (msg ? ": " + msg : ""));
        err.status = r.status; throw err;
      });
      return accept === "raw" ? r.text() : r.status === 204 ? null : r.json();
    });
  }
  function raw(path, ref) {
    return fetch(API + repoPath("/contents/" + path + "?ref=" + ref), {
      cache: "no-store", headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.raw+json" },
    }).then(function (r) { if (!r.ok) throw new Error("Couldn't read " + path + " (" + r.status + ")"); return r.text(); });
  }

  function signIn(t) {
    token = String(t || "").trim();
    if (!token) return Promise.reject(new Error("Paste a token."));
    return Promise.all([req("GET", "/user"), req("GET", repoPath(""))]).then(function (res) {
      var user = res[0], repo = res[1];
      if (!repo.permissions || !repo.permissions.push) throw new Error(user.login + " can't write to " + SITE.owner + "/" + SITE.repo + ". Ask the owner to add you as a collaborator, or check the token's repository access.");
      who = user.login;
      try { localStorage.setItem("slToken", token); localStorage.setItem("slWho", who); } catch (e) {}
      return who;
    }, function (e) { token = null; throw e; });
  }
  function signOut() { token = null; who = ""; try { localStorage.removeItem("slToken"); localStorage.removeItem("slWho"); } catch (e) {} }

  function head() { return req("GET", repoPath("/git/ref/heads/" + SITE.branch)).then(function (r) { return r.object.sha; }); }

  // Latest data files at a commit: { key: { text, value } }
  function readAt(sha) {
    return Promise.all(KEYS.map(function (k) { return raw("data/" + League.FILES[k], sha); })).then(function (texts) {
      var out = {};
      KEYS.forEach(function (k, i) { out[k] = { text: texts[i], value: JSON.parse(texts[i]) }; });
      return out;
    });
  }

  function commit(base, files, message) {
    return req("GET", repoPath("/git/commits/" + base)).then(function (c) {
      return req("POST", repoPath("/git/trees"), {
        base_tree: c.tree.sha,
        tree: files.map(function (f) { return { path: f.path, mode: "100644", type: "blob", content: f.content }; }),
      });
    }).then(function (tree) {
      return req("POST", repoPath("/git/commits"), { message: message, tree: tree.sha, parents: [base] });
    }).then(function (c) {
      // not forced: fails with 422 if main moved since `base`
      return req("PATCH", repoPath("/git/refs/heads/" + SITE.branch), { sha: c.sha, force: false }).then(function () { return c.sha; });
    });
  }

  function apply(steps, attempt) {
    attempt = attempt || 1;
    if (!token) return Promise.reject(new Error("Your admin session expired. Sign in again."));
    var base;
    return head().then(function (sha) { base = sha; return readAt(sha); }).then(function (cur) {
      var D = {};
      KEYS.forEach(function (k) { D[k] = JSON.parse(cur[k].text); });
      var logs = steps.map(function (s) { return Mutations[s[0]](D, s[1]).log; });
      var results = logs;
      D.adminLog.unshift({ ts: new Date().toISOString(), who: who, action: steps.map(function (s) { return LABELS[s[0]] || s[0]; }).join(", "), details: logs.join(" · ") });
      var files = KEYS.filter(function (k) { return League.toJson(D[k]) !== cur[k].text; })
        .map(function (k) { return { path: "data/" + League.FILES[k], content: League.toJson(D[k]) }; });
      var msg = (LABELS[steps[0][0]] || steps[0][0]) + ": " + logs.join("; ").slice(0, 120) + "\n\nBy " + who + " on the commissioner page.";
      return commit(base, files, msg).then(function () { return { D: D, logs: results }; });
    }).catch(function (e) {
      if (e.status === 422 && attempt < 4) return apply(steps, attempt + 1); // someone else committed first: redo on the new data
      throw e;
    });
  }

  var LABELS = { saveContract: "Contract", deleteContract: "Delete contract", addHold: "Add cap hold", removeHold: "Remove cap hold",
    waiveResign: "Waived & re-signed", recordCash: "Cash", deleteCash: "Delete cash row", setRanks: "Power rankings", extend: "Extension" };

  // Starts the sync workflow now instead of waiting for the next 5-minute run
  function runSync() {
    return req("POST", repoPath("/actions/workflows/" + SITE.workflow + "/dispatches"), { ref: SITE.branch });
  }

  function adminLog() { return head().then(function (sha) { return raw("data/" + League.FILES.adminLog, sha); }).then(JSON.parse); }

  return {
    signedIn: function () { return !!token; }, who: function () { return who; },
    signIn: signIn, signOut: signOut, apply: apply, runSync: runSync, adminLog: adminLog,
  };
})();
