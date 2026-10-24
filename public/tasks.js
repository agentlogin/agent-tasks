(() => {
  const status = document.querySelector('#status'), board = document.querySelector('#board'), signin = document.querySelector('#signin');
  let busy = false, generation = 0, pendingCreate, pendingUncertain = false;
  const message = text => { status.textContent = text; };
  function failure(error, current, fallback) {
    if (current !== generation) return;
    if (error.status === 401) { board.hidden = true; signin.hidden = false; message('Sign in again to continue. Your saved tasks are kept.'); }
    else message(fallback);
  }
  async function request(path, body) {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', mode: 'cors', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(10_000), ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) { const error = new Error('request_failed'); error.status = response.status; error.code = result.error; throw error; }
    return result;
  }
  async function refresh(current) {
    const me = await request('/me');
    if (current !== generation) return false;
    const { tasks } = await request('/tasks');
    if (current !== generation) return false;
    if (pendingCreate && tasks.some(task => task.id === pendingCreate.id && task.title === pendingCreate.title)) {
      if (document.querySelector('#title').value === pendingCreate.title) document.querySelector('#title').value = '';
      pendingCreate = undefined; pendingUncertain = false;
    }
    document.querySelector('#identity').textContent = me.handle;
    board.hidden = false; signin.hidden = true;
    const list = document.querySelector('#tasks'); list.replaceChildren();
    document.querySelector('#empty').hidden = tasks.length > 0;
    for (const task of tasks) {
      const item = document.createElement('li'), title = document.createElement('span'), button = document.createElement('button');
      title.textContent = task.title; item.className = task.completed ? 'completed' : '';
      button.textContent = task.completed ? 'Completed' : 'Mark done'; button.disabled = task.completed;
      button.addEventListener('click', () => action(async current => {
        try { await request('/tasks/complete', { id: task.id }); }
        catch (error) { failure(error, current, 'Completion was not confirmed. Check saved tasks before retrying.'); return; }
        item.className = 'completed'; button.textContent = 'Completed'; button.disabled = true;
        await afterWrite(current, 'Task completed.');
      }));
      item.append(title, button); list.append(item);
    }
    return true;
  }
  async function afterWrite(current, success) {
    // A refresh error cannot turn an acknowledged write into uncertainty or create a new request ID.
    try { if (await refresh(current)) message(success); }
    catch (error) {
      if (current !== generation) return;
      if (error.status === 401) { board.hidden = true; signin.hidden = false; message(success + ' Sign in again to view your saved tasks.'); }
      else message(success + ' The list could not refresh. Use Check saved tasks to refresh it.');
    }
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    const current = ++generation; // Invalidate earlier reads and their errors before any mutation.
    const controls = [...document.querySelectorAll('#board button, #board input')];
    const states = controls.map(c => c.disabled); controls.forEach(c => { c.disabled = true; });
    try { await fn(current); }
    catch (error) { failure(error, current, 'The action could not be confirmed. Check saved tasks before trying again.'); }
    finally { controls.forEach((c, i) => { if (c.isConnected && c.textContent !== 'Completed') c.disabled = states[i]; }); busy = false; }
  }
  document.querySelector('#create-task').addEventListener('submit', event => {
    event.preventDefault();
    const input = document.querySelector('#title'), title = input.value;
    void action(async current => {
      if (pendingCreate && pendingCreate.title !== title) { message('The previous task may already be saved. Retry its original title before adding another task.'); return; }
      pendingCreate ??= { id: crypto.randomUUID(), title };
      try { await request('/tasks', pendingCreate); }
      catch (error) {
        if (!pendingUncertain && error.status >= 400 && error.status < 500) pendingCreate = undefined;
        else pendingUncertain = true;
        // An explicit later submission retries this exact ID and title; never silently choose another ID.
        failure(error, current, pendingCreate ? 'Save was not confirmed. Use Check saved tasks, then submit this same title again to retry the original request.' : 'The task was refused. Check its title and the 100-task limit before trying again.');
        return;
      }
      pendingCreate = undefined; pendingUncertain = false; input.value = '';
      await afterWrite(current, 'Task added.');
    });
  });
  document.querySelector('#refresh').addEventListener('click', () => action(async current => {
    try { if (await refresh(current)) message(pendingCreate ? 'List refreshed. If needed, submit the original title to retry the same saved request.' : 'Task list refreshed.'); }
    catch (error) { failure(error, current, 'The list could not refresh. No task was changed.'); }
  }));
  document.querySelector('#logout').addEventListener('click', () => action(async current => {
    try { await request('/logout', {}); }
    catch (error) { failure(error, current, 'Sign-out was not confirmed. Check your connection and try again.'); return; }
    pendingCreate = undefined; pendingUncertain = false; board.hidden = true; signin.hidden = false; message('Signed out. Your tasks are saved.');
  }));
  const initial = ++generation;
  refresh(initial).catch(error => {
    if (initial !== generation) return;
    if (error.status === 401) message('Sign in to see your tasks.');
    else failure(error, initial, 'The task list could not load. Refresh to try again.');
  });
})();
