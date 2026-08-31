import { useState } from 'react';
import type { FormEvent } from 'react';
import { createProject, type ProjectView } from '../../services/project-api.js';

export function Projects({ onCreated }: { onCreated: (view: ProjectView) => void }) {
  const [objective, setObjective] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!objective.trim()) {
      setError('Enter an objective to start a project.');
      return;
    }
    setBusy(true);
    try {
      onCreated(await createProject(objective.trim()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Project creation failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <h1>Projects</h1>
      <p>Start one bounded, supervised project.</p>
      <form onSubmit={submit} noValidate>
        <label htmlFor="objective">Software objective</label>
        <textarea
          id="objective"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          aria-describedby={error ? 'objective-error' : undefined}
        />
        {error && (
          <div id="objective-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Starting…' : 'Start project'}
        </button>
      </form>
    </main>
  );
}
