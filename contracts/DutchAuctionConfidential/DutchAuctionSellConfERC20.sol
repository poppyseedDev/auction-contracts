// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "fhevm/lib/TFHE.sol";
import { ConfidentialERC20 } from "fhevm-contracts/contracts/token/ERC20/ConfidentialERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "fhevm/config/ZamaFHEVMConfig.sol";
import "fhevm/config/ZamaGatewayConfig.sol";
import "fhevm/gateway/GatewayCaller.sol";

/// @title Dutch Auction for Selling Confidential ERC20 Tokens
/// @notice Implements a Dutch auction mechanism for selling confidential ERC20 tokens
/// @dev Uses FHEVM for handling encrypted values and transactions
contract DutchAuctionSellingConfidentialERC20 is
    SepoliaZamaFHEVMConfig,
    SepoliaZamaGatewayConfig,
    GatewayCaller,
    Ownable2Step
{
    /// @notice The ERC20 token being auctioned
    ConfidentialERC20 public immutable token;
    /// @notice The token used for payments
    ConfidentialERC20 public immutable paymentToken;
    /// @notice Encrypted amount of tokens remaining in the auction
    euint64 private tokensLeft;

    /// @notice Address of the seller
    address payable public immutable seller;
    /// @notice Initial price per token
    uint64 public immutable startingPrice;
    /// @notice Rate at which the price decreases
    uint64 public immutable discountRate;
    /// @notice Timestamp when the auction starts
    uint256 public immutable startAt;
    /// @notice Timestamp when the auction ends
    uint256 public immutable expiresAt;
    /// @notice Timestamp when the auction refund claims end
    uint256 public immutable claimsExpiresAt;
    /// @notice Minimum price per token
    uint64 public immutable reservePrice;
    /// @notice Total amount of tokens being auctioned
    uint64 public immutable amount;
    /// @notice Flag indicating if the auction has started
    bool public auctionStart = false;

    /// @notice Flag to determine if the auction can be stopped manually
    bool public stoppable;

    /// @notice Flag to check if the auction has been manually stopped
    bool public manuallyStopped = false;

    /// @notice Decrypted value of remaining tokens
    uint64 public tokensLeftReveal;

    /// @notice Structure to store bid information
    /// @param tokenAmount Amount of tokens bid for
    /// @param paidAmount Amount paid for the tokens
    struct Bid {
        euint64 tokenAmount;
        euint64 paidAmount;
    }
    /// @notice Mapping of addresses to their bids
    mapping(address => Bid) public bids;

    /// @notice Emitted when a bid is submitted
    /// @param buyer Address of the bidder
    /// @param pricePerToken Price per token at the time of bid
    event BidSubmitted(address indexed buyer, uint pricePerToken);

    /// @notice Error thrown when a function is called too early
    /// @dev Includes the time when the function can be called
    error TooEarly(uint256 time);

    /// @notice Error thrown when a function is called too late
    /// @dev Includes the time after which the function cannot be called
    error TooLate(uint256 time);

    /// @notice Error thrown when trying to start an already started auction
    error AuctionAlreadyStarted();
    /// @notice Error thrown when trying to interact with an unstarted auction
    error AuctionNotStarted();

    /// @notice Creates a new Dutch auction contract
    /// @param _startingPrice Initial price per token
    /// @param _discountRate Rate at which price decreases
    /// @param _token Address of token being auctioned
    /// @param _paymentToken Address of token used for payment
    /// @param _amount Total amount of tokens to auction
    /// @param _reservePrice Minimum price per token
    /// @param _biddingTime Duration of the auction in seconds
    /// @param _isStoppable Whether the auction can be stopped manually
    constructor(
        uint64 _startingPrice,
        uint64 _discountRate,
        ConfidentialERC20 _token,
        ConfidentialERC20 _paymentToken,
        uint64 _amount,
        uint64 _reservePrice,
        uint256 _biddingTime,
        bool _isStoppable
    ) Ownable(msg.sender) {
        seller = payable(msg.sender);
        startingPrice = _startingPrice;
        discountRate = _discountRate;
        startAt = block.timestamp;
        expiresAt = block.timestamp + _biddingTime;
        claimsExpiresAt = block.timestamp + 3 * _biddingTime; // could choose a potentially different design
        reservePrice = _reservePrice;
        stoppable = _isStoppable;

        require(_startingPrice >= _discountRate * _biddingTime + _reservePrice, "Starting price too low");
        require(_reservePrice > 0, "Reserve price must be greater than zero");
        require(_startingPrice > _reservePrice, "Starting price must be greater than reserve price");

        amount = _amount; // initial amount should be known
        tokensLeft = TFHE.asEuint64(_amount);
        tokensLeftReveal = _amount;
        token = _token;
        paymentToken = _paymentToken;
        TFHE.allowThis(tokensLeft);
        TFHE.allow(tokensLeft, owner());
    }

    /// @notice Initializes the auction by transferring tokens from seller
    /// @dev Can only be called once by the owner
    function initialize() external onlyOwner {
        if (auctionStart) revert AuctionAlreadyStarted();

        euint64 encAmount = TFHE.asEuint64(amount);

        TFHE.allowTransient(encAmount, address(token));

        // Transfer tokens from seller to the auction contract
        token.transferFrom(msg.sender, address(this), encAmount);

        euint64 balanceAfter = token.balanceOf(address(this));

        ebool encAuctionStart = TFHE.select(TFHE.ge(balanceAfter, amount), TFHE.asEbool(true), TFHE.asEbool(false));

        uint256[] memory cts = new uint256[](1);
        cts[0] = Gateway.toUint256(encAuctionStart);
        Gateway.requestDecryption(cts, this.callbackBool.selector, 0, block.timestamp + 100, false);
    }

    /// @notice Callback function for boolean decryption
    /// @dev Only callable by the Gateway contract
    /// @param encAuctionStart The decrypted boolean
    /// @return The decrypted value
    function callbackBool(uint256, bool encAuctionStart) public onlyGateway returns (bool) {
        auctionStart = encAuctionStart;
        return encAuctionStart;
    }

    /// @notice Gets the current price per token
    /// @dev Price decreases linearly over time until it reaches reserve price
    /// @return Current price per token in payment token units
    function getPrice() public view returns (uint64) {
        if (block.timestamp >= expiresAt) {
            return reservePrice;
        }

        uint256 timeElapsed = block.timestamp - startAt;
        uint256 discount = discountRate * timeElapsed;
        uint64 currentPrice = startingPrice > uint64(discount) ? startingPrice - uint64(discount) : 0;
        return currentPrice > reservePrice ? currentPrice : reservePrice;
    }

    /// @notice Manually stop the auction
    /// @dev Can only be called by the owner and if the auction is stoppable
    function stop() external onlyOwner {
        require(stoppable);
        manuallyStopped = true;
    }

    /// @notice Submit a bid for tokens
    /// @dev Handles bid logic including refunds from previous bids
    /// @param encryptedValue Encrypted amount of tokens to bid for
    /// @param inputProof Zero-knowledge proof for the encrypted input
    function bid(einput encryptedValue, bytes calldata inputProof) external onlyBeforeEnd {
        euint64 newTokenAmount = TFHE.asEuint64(encryptedValue, inputProof);
        uint64 currentPricePerToken = getPrice();

        // Calculate costs for new tokens
        euint64 newTokensCost = TFHE.mul(currentPricePerToken, newTokenAmount);

        // Handle previous bid adjustments
        Bid storage userBid = bids[msg.sender];
        // Verify enough tokens are available
        ebool enoughTokens = TFHE.le(newTokenAmount, tokensLeft);

        if (TFHE.isInitialized(userBid.tokenAmount)) {
            // Previous bid exists - calculate price difference
            euint64 oldTokenAmount = userBid.tokenAmount;
            euint64 oldPaidAmount = userBid.paidAmount;

            // Calculate cost of old tokens at new (lower) price
            euint64 oldTokensAtNewPrice = TFHE.mul(currentPricePerToken, oldTokenAmount);

            euint64 totalTokenPrice = TFHE.add(oldTokensAtNewPrice, newTokensCost);
            // if totalTokenAmount greater than oldPaidAmount extra payment and no refund needed else refund
            ebool refundNotNeeded = TFHE.ge(totalTokenPrice, oldPaidAmount);
            euint64 amountToTransfer = TFHE.select(
                refundNotNeeded,
                TFHE.sub(totalTokenPrice, oldPaidAmount),
                TFHE.asEuint64(0)
            );
            euint64 amountToRefund = TFHE.select(
                refundNotNeeded,
                TFHE.asEuint64(0),
                TFHE.sub(oldPaidAmount, totalTokenPrice)
            );

            // Verify enough tokens are available
            newTokensCost = TFHE.select(enoughTokens, newTokensCost, TFHE.asEuint64(0));
            amountToTransfer = TFHE.select(enoughTokens, amountToTransfer, TFHE.asEuint64(0));
            amountToRefund = TFHE.select(enoughTokens, amountToRefund, TFHE.asEuint64(0));

            euint64 sentBalance = _handleTransfer(amountToTransfer);
            _handleRefund(amountToRefund);

            // 0 or newTokenAmount depending if the transfer was successful or refund was successful
            ebool txSuccess = TFHE.or(TFHE.ne(sentBalance, 0), TFHE.ne(amountToRefund, 0));
            newTokenAmount = TFHE.select(txSuccess, newTokenAmount, TFHE.asEuint64(0));

            totalTokenPrice = TFHE.select(txSuccess, totalTokenPrice, oldPaidAmount);

            // Total tokens = previous tokens + new tokens
            euint64 totalTokens = TFHE.add(newTokenAmount, oldTokenAmount);

            // Optional *depending on contract design choise* transfer tokens to user
            _handleTokenTransfer(newTokenAmount);

            _updateBidInfo(totalTokens, totalTokenPrice, newTokenAmount);
        } else {
            // Verify enough tokens are available
            newTokensCost = TFHE.select(enoughTokens, newTokensCost, TFHE.asEuint64(0));
            newTokenAmount = TFHE.select(enoughTokens, newTokenAmount, TFHE.asEuint64(0));

            // Extract transfer logic into helper function
            euint64 sentBalance = _handleTransfer(newTokensCost);

            newTokenAmount = TFHE.select(TFHE.ne(sentBalance, 0), newTokenAmount, TFHE.asEuint64(0));

            // Optional *depending on contract design choise* transfer tokens to user
            _handleTokenTransfer(newTokenAmount);

            _updateBidInfo(newTokenAmount, sentBalance, newTokenAmount);
        }

        emit BidSubmitted(msg.sender, currentPricePerToken);
    }

    /// @dev Helper function to handle token transfers
    function _handleTransfer(euint64 amountToTransfer) private returns (euint64) {
        euint64 balanceBefore = paymentToken.balanceOf(address(this));
        TFHE.allowTransient(amountToTransfer, address(paymentToken));
        paymentToken.transferFrom(msg.sender, address(this), amountToTransfer);
        euint64 balanceAfter = paymentToken.balanceOf(address(this));
        return TFHE.sub(balanceAfter, balanceBefore);
    }

    /// @dev Helper function to handle refunds
    function _handleRefund(euint64 amountToTransfer) private {
        TFHE.allowTransient(amountToTransfer, address(paymentToken));
        paymentToken.transfer(msg.sender, amountToTransfer);
    }

    /// @dev Helper function to handle token transfer
    function _handleTokenTransfer(euint64 amountToTransfer) private {
        TFHE.allowTransient(amountToTransfer, address(token));
        token.transfer(msg.sender, amountToTransfer);
    }

    /// @dev Helper function to update bid information
    function _updateBidInfo(euint64 totalTokenAmount, euint64 totalPaidAmount, euint64 newTokenAmount) private {
        bids[msg.sender].tokenAmount = totalTokenAmount;
        bids[msg.sender].paidAmount = totalPaidAmount;
        TFHE.allowThis(bids[msg.sender].tokenAmount);
        TFHE.allowThis(bids[msg.sender].paidAmount);
        TFHE.allow(bids[msg.sender].tokenAmount, msg.sender);
        TFHE.allow(bids[msg.sender].paidAmount, msg.sender);

        // Update remaining tokens
        tokensLeft = TFHE.sub(tokensLeft, newTokenAmount);
        TFHE.allowThis(tokensLeft);
        TFHE.allow(tokensLeft, owner());
    }

    /// @notice Claim tokens and refund for a bidder after auction ends
    /// @dev Transfers tokens to bidder and refunds excess payment based on final price
    function claimUserRefund() external onlyAfterAuctionEnds {
        Bid storage userBid = bids[msg.sender];

        uint finalPrice = getPrice();
        euint64 finalPricePerToken = TFHE.asEuint64(finalPrice);
        euint64 finalCost = TFHE.mul(finalPricePerToken, userBid.tokenAmount);
        euint64 refundAmount = TFHE.sub(userBid.paidAmount, finalCost);

        // Transfer refund
        _handleRefund(refundAmount);

        // Clear the bid
        delete bids[msg.sender];
    }

    /// @notice Claim proceeds for the seller after auction ends
    /// @dev Transfers all remaining tokens and payments to seller
    function claimSeller() external onlyOwner onlyAfterClaimsEnd {
        // Get the total amount of payment tokens in the contract
        euint64 contractPaymentBalance = paymentToken.balanceOf(address(this));
        euint64 contractAuctionBalance = token.balanceOf(address(this));

        // Transfer all payment token and auction tokens to the seller
        TFHE.allowTransient(contractPaymentBalance, address(paymentToken));
        paymentToken.transfer(seller, contractPaymentBalance);

        TFHE.allowTransient(contractAuctionBalance, address(token));
        token.transfer(seller, contractAuctionBalance);
    }

    /// @notice Request decryption of remaining tokens
    /// @dev Only owner can request decryption
    function requestTokensLeftReveal() public onlyOwner {
        uint256[] memory cts = new uint256[](1);
        cts[0] = Gateway.toUint256(tokensLeft);
        Gateway.requestDecryption(cts, this.callbackUint64.selector, 0, block.timestamp + 100, false);
    }

    /// @notice Callback function for 64-bit unsigned integer decryption
    /// @dev Only callable by the Gateway contract
    /// @param decryptedInput The decrypted 64-bit unsigned integer
    /// @return The decrypted value
    function callbackUint64(uint256, uint64 decryptedInput) public onlyGateway returns (uint64) {
        tokensLeftReveal = decryptedInput;
        return decryptedInput;
    }

    /// @notice Cancel the auction and return tokens to seller
    /// @dev Only owner can cancel before auction ends
    function cancelAuction() external onlyOwner onlyBeforeEnd {
        TFHE.allowTransient(tokensLeft, address(token));

        // Refund remaining tokens
        token.transfer(seller, tokensLeft);
    }

    /// @notice Modifier to ensure function is called before auction ends
    /// @dev Reverts if called after the auction end time or if manually stopped
    modifier onlyBeforeEnd() {
        if (!auctionStart) revert AuctionNotStarted();
        if (block.timestamp >= expiresAt || manuallyStopped == true) revert TooLate(expiresAt);
        _;
    }

    /// @notice Modifier to ensure function is called after auction ends
    /// @dev Reverts if called before the auction end time and called after claims time expire and not manually stopped
    modifier onlyAfterAuctionEnds() {
        if (!auctionStart) revert AuctionNotStarted();
        if (block.timestamp < expiresAt && manuallyStopped == false) revert TooEarly(expiresAt);
        if (block.timestamp >= claimsExpiresAt) revert TooLate(claimsExpiresAt);
        _;
    }

    /// @notice Modifier to ensure function is called after refund claim period ends
    /// @dev Reverts if called before the auction refund claims period end time and not manually stopped
    modifier onlyAfterClaimsEnd() {
        if (!auctionStart) revert AuctionNotStarted();
        if (block.timestamp < claimsExpiresAt && manuallyStopped == false) revert TooEarly(claimsExpiresAt);
        _;
    }

    /// @notice Get the user's current bid information
    /// @dev Returns the decrypted values of token amount and paid amount
    /// @return tokenAmount Amount of tokens bid for
    /// @return paidAmount Amount paid for the tokens
    function getUserBid() external view returns (euint64 tokenAmount, euint64 paidAmount) {
        Bid storage userBid = bids[msg.sender];
        return (userBid.tokenAmount, userBid.paidAmount);
    }
}
