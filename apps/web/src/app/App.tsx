import { useEffect, useState } from 'react';
import { Projects } from '../features/projects/Projects.js';
import { Observe } from '../features/observe/Observe.js';
import { Supervise } from '../features/supervise/Supervise.js';
import { Results } from '../features/results/Results.js';
import { bootstrap, getProject, type ProjectView } from '../services/project-api.js';

const ACTIVE_PROJECT_KEY = 'moonshift.activeProjectId';
export function App() {
  const [session, setSession] = useState<'loading' | 'ready' | 'error'>('loading');
  const [project, setProject] = useState<ProjectView>();
  const [view, setView] = useState<'observe' | 'supervise' | 'results'>('observe');
  useEffect(() => {
    const secret = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
    history.replaceState(null, '', location.pathname + location.search);
    void (async () => {
      try {
        if (secret) await bootstrap(secret);
        const projectId = localStorage.getItem(ACTIVE_PROJECT_KEY);
        if (projectId !== null) {
          try {
            setProject(await getProject(projectId));
          } catch {
            localStorage.removeItem(ACTIVE_PROJECT_KEY);
          }
        }
        setSession('ready');
      } catch {
        setSession('error');
      }
    })();
  }, []);
  if (session === 'loading') return <p role="status">Connecting to Moonshift…</p>;
  if (session === 'error')
    return (
      <main>
        <h1>Moonshift</h1>
        <div role="alert">Unable to establish the supervisor session.</div>
      </main>
    );
  if (project === undefined)
    return (
      <Projects
        onCreated={(created) => {
          localStorage.setItem(ACTIVE_PROJECT_KEY, created.projectId);
          setProject(created);
          setView('observe');
        }}
      />
    );
  return (
    <>
      <nav aria-label="Project views">
        <button onClick={() => setView('observe')} aria-pressed={view === 'observe'}>
          Observe
        </button>{' '}
        <button onClick={() => setView('supervise')} aria-pressed={view === 'supervise'}>
          Supervise
        </button>{' '}
        <button onClick={() => setView('results')} aria-pressed={view === 'results'}>
          Results
        </button>
      </nav>
      {view === 'observe' ? (
        <Observe initial={project} />
      ) : view === 'supervise' ? (
        <Supervise
          initial={project}
          onProjectChange={(changed) => {
            localStorage.setItem(ACTIVE_PROJECT_KEY, changed.projectId);
            setProject(changed);
          }}
        />
      ) : (
        <Results projectId={project.projectId} />
      )}
    </>
  );
}
