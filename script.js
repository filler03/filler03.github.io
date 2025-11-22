// Get the button and heading elements
const button = document.getElementById('button');
const heading = document.getElementById('heading');

// Add an event listener to the button
button.addEventListener('click', () => {
 heading.textContent = 'Button clicked!';
});