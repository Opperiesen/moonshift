import { useEffect, useState } from 'react';
import { Projects } from '../features/projects/Projects.js';
import { Observe } from '../features/observe/Observe.js';
import { Supervise } from '../features/supervise/Supervise.js';
import { bootstrap, type ProjectView } from '../services/project-api.js';
export function App() {
  const [session, setSession] = useState<'loading' | 'ready' | 'error'>('loading');
  const [project, setProject] = useState<ProjectView>();
  const [view, setView] = useState<'observe' | 'supervise'>('observe');
  useEffect(() => {
    const secret = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
    history.replaceState(null, '', location.pathname + location.search);
    if (!secret) {
      setSession('ready');
      return;
    }
    void bootstrap(secret)
      .then(() => setSession('ready'))
      .catch(() => setSession('error'));
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
        </button>
      </nav>
      {view === 'observe' ? (
        <Observe initial={project} />
      ) : (
        <Supervise initial={project} onProjectChange={setProject} />
      )}
    </>
  );
}
