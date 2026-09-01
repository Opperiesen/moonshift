import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  getResults,
  type ResultArtifactView,
  type ResultEvidenceView,
  type ResultView,
} from '../../services/project-api.js';

const label = (value: string) =>
  value
    .replaceAll('_', ' ')
    .toLocaleLowerCase('en-US')
    .replace(/^./u, (character) => character.toLocaleUpperCase('en-US'));

function latestVerificationDecision(view: ResultView): ResultView['audit'][number] | undefined {
  return [...view.audit].reverse().find(({ action }) => action === 'verification.decided');
}

function verificationState(view: ResultView): string {
  const decision = latestVerificationDecision(view);
  if (view.task.state === 'VERIFYING' && decision?.outcome === 'STALE') {
    return 'Stale · reevaluation required';
  }
  if (view.task.state === 'CLAIMED_COMPLETE') return 'Claimed complete';
  return label(view.task.state);
}

function latestArtifact(view: ResultView): ResultArtifactView | undefined {
  return view.artifacts.at(-1);
}

function integrityEvidence(view: ResultView): ResultEvidenceView | undefined {
  return [...view.evidence].reverse().find((item) => item.type === 'INTEGRITY');
}

function integrityState(view: ResultView): 'matched' | 'mismatch' | 'pending' {
  const artifact = latestArtifact(view);
  const evidence = integrityEvidence(view);
  if (artifact === undefined || evidence === undefined) return 'pending';
  return evidence.status === 'PASS' &&
    evidence.sourceHash === artifact.contentHash &&
    evidence.gitRevision === artifact.gitRevision &&
    artifact.gitRevision === view.task.expectedRevision
    ? 'matched'
    : 'mismatch';
}

function blockingReasons(view: ResultView): readonly string[] {
  const reasons: string[] = [];
  const decision = latestVerificationDecision(view);
  if (decision?.outcome === 'STALE') reasons.push(decision.reason);
  if (view.task.state === 'CLAIMED_COMPLETE') reasons.push('Awaiting independent verification');
  for (const evidence of view.evidence) {
    if (evidence.status !== 'PASS') {
      reasons.push(`Required ${evidence.type} evidence did not pass`);
    }
    if (evidence.gitRevision !== view.task.expectedRevision) {
      reasons.push(`Required ${evidence.type} evidence is bound to another revision`);
    }
  }
  const artifact = latestArtifact(view);
  if (artifact !== undefined && artifact.gitRevision !== view.task.expectedRevision) {
    reasons.push('Published artifact is bound to another revision');
  }
  if (integrityState(view) === 'mismatch') {
    reasons.push('Artifact integrity evidence does not match the published content hash');
  }
  if (
    view.organizationLineage.reviewerAgentId !== null &&
    !view.organizationLineage.independentReview
  ) {
    reasons.push('Quality reviewer must be outside the author lineage');
  }
  if (view.task.state === 'VERIFYING' && reasons.length === 0) {
    reasons.push('Verification evaluation is pending');
  }
  if (view.task.state === 'BLOCKED' && reasons.length === 0) {
    reasons.push('Verification policy did not pass');
  }
  return [...new Set(reasons)];
}

export function Results({ projectId }: { readonly projectId: string }) {
  const [view, setView] = useState<ResultView>();
  const [status, setStatus] = useState('Loading results…');

  const refresh = useCallback(async () => {
    setStatus('Loading results…');
    const next = await getResults(projectId);
    setView(next);
    setStatus('Results ready');
  }, [projectId]);

  useEffect(() => {
    void refresh().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : 'Unable to load project results.');
    });
  }, [refresh]);

  const blockers = useMemo(() => (view === undefined ? [] : blockingReasons(view)), [view]);
  const artifact = view === undefined ? undefined : latestArtifact(view);
  const integrity = view === undefined ? 'pending' : integrityState(view);

  return (
    <main>
      <h1>Results</h1>
      <p role="status" data-testid="results-status">
        {status}
      </p>
      <button onClick={() => void refresh()} disabled={status === 'Loading results…'}>
        Refresh results
      </button>

      {view !== undefined && (
        <>
          <section aria-labelledby="result-summary-heading">
            <h2 id="result-summary-heading">Verification summary</h2>
            <p>
              Project control state: <strong>{label(view.projectState)}</strong>
            </p>
            <p>
              Task state:{' '}
              <strong data-testid="verification-state">{verificationState(view)}</strong>
            </p>
            <p data-testid="verified-flag">Verified: {view.verified ? 'Yes' : 'No'}</p>
            <p>
              Expected revision: <code>{view.task.expectedRevision}</code>
            </p>
            <p data-testid="artifact-integrity">
              {integrity === 'matched'
                ? 'Integrity matched'
                : integrity === 'mismatch'
                  ? 'Integrity mismatch'
                  : 'Integrity pending'}
            </p>
            <div data-testid="reviewer-lineage">
              <p>
                Author lineage: <code>{view.organizationLineage.authorLineageId}</code>
              </p>
              {view.organizationLineage.reviewerAgentId === null ? (
                <p>Reviewer not assigned</p>
              ) : (
                <>
                  <p>
                    Reviewer lineage: <code>{view.organizationLineage.reviewerLineageId}</code>
                  </p>
                  <p>
                    Independent review: {view.organizationLineage.independentReview ? 'Yes' : 'No'}
                  </p>
                </>
              )}
            </div>
            <div data-testid="blocking-reasons">
              <h3>Blocking reasons</h3>
              {blockers.length === 0 ? (
                <p>No blocking reasons</p>
              ) : (
                <ul>
                  {blockers.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section aria-labelledby="artifacts-heading">
            <h2 id="artifacts-heading">Artifacts</h2>
            {artifact === undefined ? (
              <p>No artifact published.</p>
            ) : (
              <table aria-label="Artifacts">
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col">Content hash</th>
                    <th scope="col">Revision</th>
                    <th scope="col">Bytes</th>
                  </tr>
                </thead>
                <tbody>
                  {view.artifacts.map((item) => (
                    <tr key={item.artifactId}>
                      <td>{item.kind}</td>
                      <td>
                        <code>{item.contentHash}</code>
                      </td>
                      <td>
                        <code>{item.gitRevision}</code>
                      </td>
                      <td>{item.size}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="evidence-heading">
            <h2 id="evidence-heading">Evidence</h2>
            <table aria-label="Evidence matrix">
              <thead>
                <tr>
                  <th scope="col">Rule</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Producer</th>
                  <th scope="col">Revision</th>
                  <th scope="col">Source hash</th>
                </tr>
              </thead>
              <tbody>
                {view.evidence.map((item) => (
                  <tr key={item.evidenceId}>
                    <th scope="row">{item.type}</th>
                    <td>{item.status}</td>
                    <td>
                      <code>{item.producerAgentId}</code>
                    </td>
                    <td>
                      <code>{item.gitRevision}</code>
                    </td>
                    <td>
                      <code>{item.sourceHash}</code>
                    </td>
                  </tr>
                ))}
                {view.evidence.length === 0 && (
                  <tr>
                    <td colSpan={5}>No evidence recorded.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          <section aria-labelledby="approvals-heading">
            <h2 id="approvals-heading">Approval history</h2>
            {view.approvals.length === 0 ? (
              <p>No approvals recorded.</p>
            ) : (
              <ol>
                {view.approvals.map((approval) => (
                  <li key={approval.approvalId}>
                    {label(approval.state)} · {approval.reason} ·{' '}
                    <code>{approval.actionDigest}</code>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="executions-heading">
            <h2 id="executions-heading">Backend executions</h2>
            {view.executions.map((execution) => (
              <article key={execution.executionId}>
                <h3>{label(execution.state)}</h3>
                <p>
                  Connection <code>{execution.backendConnectionId}</code> · descriptor{' '}
                  <code>{execution.modelDescriptorId}</code> v{execution.modelDescriptorVersion} ·
                  attempt {execution.attemptNumber}
                </p>
              </article>
            ))}
          </section>

          <section aria-labelledby="checkpoints-heading">
            <h2 id="checkpoints-heading">Checkpoints and effects</h2>
            {view.checkpoints.length === 0 ? (
              <p>No checkpoint recorded.</p>
            ) : (
              <ul>
                {view.checkpoints.map((checkpoint) => (
                  <li key={checkpoint.checkpointId}>
                    Checkpoint {checkpoint.schemaVersion} · <code>{checkpoint.contentHash}</code> ·{' '}
                    {checkpoint.createdAt}
                  </li>
                ))}
              </ul>
            )}
            <ul>
              {view.effects.map((effect) => (
                <li key={effect.effectId}>
                  Effect {label(effect.state)} · <code>{effect.actionDigest}</code>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="audit-heading">
            <h2 id="audit-heading">Audit timeline</h2>
            <ol>
              {view.audit.map((item) => (
                <li key={item.auditEventId}>
                  {item.sequence}. {item.occurredAt} · {item.actorType} · {item.action} ·{' '}
                  {item.outcome}
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </main>
  );
}
