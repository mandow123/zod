export const isAdminDemo = import.meta.env.MODE === 'demo'
  || import.meta.env.VITE_ADMIN_DEMO === 'true';
