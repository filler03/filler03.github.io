class CoffeeCup {
 constructor(strength, type) {
 this.strength = strength;
 this.type = type;
 }

 alertProperties() {
 alert(`Coffee Cup Properties:
 Strength: ${this.strength}/10
 Type: ${this.type}`);
 }
}

const coffeeButton = document.createElement('div');
coffeeButton.style.position = 'absolute';
coffeeButton.style.top = '50%';
coffeeButton.style.left = '50%';
coffeeButton.style.transform = 'translate(-50%, -50%)';
coffeeButton.style.backgroundColor = 'blue';
coffeeButton.style.width = '100px';
coffeeButton.style.height = '100px';
coffeeButton.style.cursor = 'pointer';

document.body.appendChild(coffeeButton);

coffeeButton.addEventListener('click', () => {
 const coffeeCup = new CoffeeCup(
 Math.floor(Math.random() * 10) + 1,
 ['Latte', 'Cappuccino', 'Mocha', 'Espresso'][Math.floor(Math.random() * 4)]
 );

 const coffeeCupElement = document.createElement('div');
 coffeeCupElement.style.position = 'absolute';
 coffeeCupElement.style.width = '50px';
 coffeeCupElement.style.height = '50px';
 coffeeCupElement.style.backgroundColor = 'brown';
 coffeeCupElement.style.borderRadius = '50%';
 coffeeCupElement.style.cursor = 'pointer';
 coffeeCupElement.style.top = `${Math.random() * (window.innerHeight - 50)}px`;
 coffeeCupElement.style.left = `${Math.random() * (window.innerWidth - 50)}px`;

 coffeeCupElement.addEventListener('click', () => {
 coffeeCup.alertProperties();
 });

 document.body.appendChild(coffeeCupElement);
});