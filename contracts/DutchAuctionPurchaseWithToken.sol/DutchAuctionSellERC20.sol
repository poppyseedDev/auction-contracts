// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract DutchAuctionSellingTokenWithToken {
    using SafeERC20 for IERC20;

    uint private constant DURATION = 7 days;

    IERC20 public immutable token;
    IERC20 public immutable paymentToken; // USDC for payment
    uint public immutable amount;

    address public immutable seller;
    uint public immutable startingPrice;
    uint public immutable discountRate;
    uint public immutable startAt;
    uint public immutable expiresAt;
    uint public immutable reservePrice;
    uint public tokensSold;

    event TokensPurchased(address indexed buyer, uint amount, uint price);

    constructor(
        uint _startingPrice,
        uint _discountRate,
        address _token,
        address _paymentToken,
        uint _amount,
        uint _reservePrice
    ) {
        seller = msg.sender;
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
        paymentToken = IERC20(_paymentToken);
        amount = _amount;
    }

    function getPrice() public view returns (uint) {
        uint timeElapsed = block.timestamp - startAt;
        uint discount = discountRate * timeElapsed;
        return startingPrice > discount + reservePrice ? startingPrice - discount : reservePrice;
    }

    function buy(uint tokenAmount) external {
        require(block.timestamp < expiresAt, "This auction has ended");
        require(tokensSold + tokenAmount <= amount, "Not enough tokens left");
        require(tokenAmount > 0, "Token amount must be greater than 0");

        uint pricePerToken = getPrice();
        uint totalCost = pricePerToken * tokenAmount;

        // Effects
        tokensSold += tokenAmount;

        // Interactions
        paymentToken.safeTransferFrom(msg.sender, seller, totalCost); // Payment with USDC
        token.safeTransferFrom(seller, msg.sender, tokenAmount); // Transfer auctioned tokens

        emit TokensPurchased(msg.sender, tokenAmount, pricePerToken);
    }

    function cancelAuction() external {
        require(msg.sender == seller, "Only seller can cancel");
        require(block.timestamp < expiresAt, "Auction already ended");

        // Return remaining tokens to seller
        uint remainingTokens = amount - tokensSold;
        if (remainingTokens > 0) {
            token.safeTransfer(seller, remainingTokens);
        }
    }
}
