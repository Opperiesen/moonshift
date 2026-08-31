import { useEffect, useState } from 'react';
import { Projects } from '../features/projects/Projects.js';
import { Observe } from '../features/observe/Observe.js';
import { bootstrap, type ProjectView } from '../services/project-api.js';
export function App() {
  const [session, setSession] = useState<'loading' | 'ready' | 'error'>('loading');
  const [project, setProject] = useState<ProjectView>();
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
  return project ? <Observe initial={project} /> : <Projects onCreated={setProject} />;
}
