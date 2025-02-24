// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DutchAuctionSellingERC20 {
    uint private constant DURATION = 7 days;

    IERC20 public immutable token;
    uint public immutable amount;

    address payable public immutable seller;
    uint public immutable startingPrice;
    uint public immutable discountRate;
    uint public immutable startAt;
    uint public immutable expiresAt;
    uint public immutable reservePrice;
    uint public tokensSold;

    event TokensPurchased(address indexed buyer, uint amount, uint price);

    constructor(uint _startingPrice, uint _discountRate, address _token, uint _amount, uint _reservePrice) {
        seller = payable(msg.sender);
        startingPrice = _startingPrice;
        discountRate = _discountRate;
        startAt = block.timestamp;
        expiresAt = block.timestamp + DURATION;
        reservePrice = _reservePrice;

        require(_startingPrice >= _discountRate * DURATION + _reservePrice, "Starting price too low");
        require(_amount > 0, "Token amount must be greater than zero");
        require(_reservePrice > 0, "Reserve price must be greater than zero");
        require(_startingPrice > _reservePrice, "Starting price must be greater than reserve price");

        token = IERC20(_token);
        amount = _amount;
    }

    function getPrice() public view returns (uint) {
        uint timeElapsed = block.timestamp - startAt;
        uint discount = discountRate * timeElapsed;
        return startingPrice > discount + reservePrice ? startingPrice - discount : reservePrice;
    }

    function buy(uint tokenAmount) external payable {
        require(block.timestamp < expiresAt, "This auction has ended");
        require(tokensSold + tokenAmount <= amount, "Not enough tokens left");

        uint pricePerToken = getPrice();
        uint totalCost = pricePerToken * tokenAmount;
        require(msg.value >= totalCost, "Insufficient ETH sent");

        require(token.transferFrom(seller, msg.sender, tokenAmount), "Token transfer failed");
        tokensSold += tokenAmount;

        uint refund = msg.value - totalCost;
        if (refund > 0) {
            payable(msg.sender).transfer(refund);
        }

        seller.transfer(totalCost);
        emit TokensPurchased(msg.sender, tokenAmount, pricePerToken);
    }
}
