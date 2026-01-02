# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a GitHub Pages repository (`filler03.github.io`) hosting standalone HTML games and utilities. All projects are self-contained single-file HTML applications with embedded CSS and JavaScript.

## Repository Structure

- **Root level**: Main utility apps (lifeProgress.html, multiStepCalculator.html)
- **index.html**: Landing page with navigation to games
- **games/**: Production games (basketball/, soccer/, worms.html)
- **test/**: Test versions of games (basketball/, soccer/)
- **sandbox/**: Experimental/work-in-progress files
- **sandbox/index.php**: PHP file (note: GitHub Pages doesn't support PHP server-side execution)

## Development Workflow

### No Build Process
This repository has **no build system, no package.json, no dependencies, and no tests**. All files are deployed directly as-is to GitHub Pages.

### Working with Files
- Each HTML file is completely self-contained with inline styles and scripts
- Games use HTML5 Canvas API for rendering
- All projects are mobile-responsive with touch event support
- Common patterns: requestAnimationFrame for game loops, CSS variables for theming

### Testing Changes
Since this is GitHub Pages:
1. Open HTML files directly in a browser (file:// or via local server)
2. Test on mobile by using browser dev tools device emulation
3. Push to GitHub to deploy (automatic deployment via GitHub Pages)

### Common Technologies
- **Canvas API**: Used in games (worms.html, basketball, soccer)
- **Vanilla JavaScript**: No frameworks or libraries
- **CSS Custom Properties**: Used for theming (see multiStepCalculator.html)
- **Mobile-first**: viewport meta tags, touch events, safe-area-inset for notch support

## Key Files

### Production Applications
- **multiStepCalculator.html**: Multi-flow financial calculator with compound interest support
- **lifeProgress.html**: Life progress tracker with date-based calculations
- **games/worms.html**: Slither.io-style game with chunk-based exploration system

### Navigation
- **index.html**: Main landing page with animated gradient background (rotates based on current minute progress)

## Important Notes

- Files in `sandbox/` are experimental and may not work properly
- The repository uses `test/` for development versions, `games/` for production
- All games feature smooth animations and particle effects
- Common styling approach: dark themes with gradient accents and glassmorphism effects
