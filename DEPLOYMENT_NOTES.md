Serve projects/constellation/ as the deployment root.

Upload these items together:

- projects/constellation/index.html
- projects/constellation/app.js
- projects/constellation/styles.css
- projects/constellation/data/
- projects/constellation/assets/

Required runtime paths:

- app.js fetches data/candidates.tmdb.json
- styles.css loads assets/backgrounds/constellation-bg-v1.png
- styles.css loads assets/icons/astroid.svg
- styles.css loads assets/icons/chevron-down.svg
- styles.css loads assets/icons/chevron-up.svg

The src/ folder can remain in the repo as a source copy, but it is no longer the deployment entry point.
