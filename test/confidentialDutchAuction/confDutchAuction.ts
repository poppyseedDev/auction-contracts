import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { awaitAllDecryptionResults, initGateway } from "../asyncDecrypt";
import { createInstance } from "../instance";
import { reencryptEuint64 } from "../reencrypt";
import { getSigners, initSigners } from "../signers";

describe("DutchAuctionSellingConfidentialERC20", function () {
  const STARTING_PRICE = ethers.parseEther("0.0001");
  const DISCOUNT_RATE = ethers.parseUnits("10", "wei");
  const TOKEN_AMOUNT = 1000n;
  const USDC_AMOUNT = 100000000000000000n;
  const RESERVE_PRICE = ethers.parseEther("0.00001");
  const STOPPABLE = true;
  const DURATION = 7 * 24 * 60 * 60; // 7 days in seconds

  before(async function () {
    await initSigners();
    this.signers = await getSigners();
    await initGateway();
  });

  beforeEach(async function () {
    // Deploy the token contracts first
    const ConfTokenFactory = await ethers.getContractFactory("MyConfidentialERC20");
    this.auctionToken = await ConfTokenFactory.connect(this.signers.alice).deploy("AuctionToken", "AT");
    this.paymentToken = await ConfTokenFactory.connect(this.signers.alice).deploy("PaymentToken", "PT");
    await this.auctionToken.waitForDeployment();
    await this.paymentToken.waitForDeployment();
    this.paymentTokenAddress = await this.paymentToken.getAddress();
    this.auctionTokenAddress = await this.auctionToken.getAddress();

    const tx = await this.auctionToken.mint(this.signers.alice, TOKEN_AMOUNT); // minting 10000 auction tokens to ALICE
    const t1 = await tx.wait();
    expect(t1?.status).to.eq(1);

    const tx2 = await this.paymentToken.mint(this.signers.bob, USDC_AMOUNT); // minting 10000 usdc to BOB
    const t2 = await tx2.wait();
    expect(t2?.status).to.eq(1);

    // Deploy the auction contract
    const AuctionFactory = await ethers.getContractFactory("DutchAuctionSellingConfidentialERC20");
    this.auction = await AuctionFactory.connect(this.signers.alice).deploy(
      STARTING_PRICE,
      DISCOUNT_RATE,
      this.auctionTokenAddress,
      this.paymentTokenAddress,
      TOKEN_AMOUNT,
      RESERVE_PRICE,
      DURATION,
      STOPPABLE,
    );
    await this.auction.waitForDeployment();
    this.auctionAddress = await this.auction.getAddress();

    this.instance = await createInstance();

    const input1 = this.instance.createEncryptedInput(this.auctionTokenAddress, this.signers.alice.address);
    input1.add64(TOKEN_AMOUNT);
    const aliceTokenAmount = await input1.encrypt();

    // Approve auction contract to spend tokens
    const txAliceApprove = await this.auctionToken
      .connect(this.signers.alice)
      ["approve(address,bytes32,bytes)"](this.auctionAddress, aliceTokenAmount.handles[0], aliceTokenAmount.inputProof);
    await txAliceApprove.wait();

    const txInit = await this.auction.connect(this.signers.alice).initialize();
    await txInit.wait();

    // Wait for decryption
    await awaitAllDecryptionResults();

    // Approve payment token for Bob
    const input = this.instance.createEncryptedInput(this.paymentTokenAddress, this.signers.bob.address);
    input.add64(USDC_AMOUNT);
    const bobPaymentAmount = await input.encrypt();

    const txBobApprove = await this.paymentToken
      .connect(this.signers.bob)
      ["approve(address,bytes32,bytes)"](this.auctionAddress, bobPaymentAmount.handles[0], bobPaymentAmount.inputProof);
    await txBobApprove.wait();
  });

  describe("Deployment", function () {
    it("Should set the correct initial values", async function () {
      expect(await this.auction.seller()).to.equal(this.signers.alice.address);
      expect(await this.auction.startingPrice()).to.equal(STARTING_PRICE);
      expect(await this.auction.discountRate()).to.equal(DISCOUNT_RATE);
      expect(await this.auction.reservePrice()).to.equal(RESERVE_PRICE);
      expect(await this.auction.amount()).to.equal(TOKEN_AMOUNT);
    });

    it("Should revert if starting price is too low", async function () {
      const AuctionFactory = await ethers.getContractFactory("DutchAuctionSellingConfidentialERC20");
      await expect(
        AuctionFactory.connect(this.signers.alice).deploy(
          RESERVE_PRICE, // Starting price too low
          DISCOUNT_RATE,
          await this.auctionToken.getAddress(),
          await this.paymentToken.getAddress(),
          TOKEN_AMOUNT,
          RESERVE_PRICE,
          DURATION,
          STOPPABLE,
        ),
      ).to.be.revertedWith("Starting price too low");
    });
  });

  describe("Price calculation", function () {
    it("Should return starting price at start", async function () {
      const price = await this.auction.getPrice();
      expect(price).to.be.closeTo(STARTING_PRICE, 100); // allows for small differences
    });

    it("Should decrease price over time", async function () {
      const oneDay = 24n * 60n * 60n;
      await time.increase(oneDay);

      const expectedPrice = STARTING_PRICE - DISCOUNT_RATE * oneDay;
      expect(await this.auction.getPrice()).to.be.closeTo(expectedPrice, 100);
    });

    it("Should not go below reserve price", async function () {
      const sevenDays = 7 * 24 * 60 * 60;
      await time.increase(sevenDays);

      expect(await this.auction.getPrice()).to.equal(RESERVE_PRICE);
    });
  });

  describe("Auction management", function () {
    it("Should allow owner to cancel auction", async function () {
      await expect(this.auction.connect(this.signers.alice).cancelAuction()).to.not.be.reverted;
    });

    it("Should not allow non-owner to cancel auction", async function () {
      await expect(this.auction.connect(this.signers.bob).cancelAuction()).to.be.reverted;
    });

    it("Should not allow cancellation after expiration", async function () {
      await time.increase(7 * 24 * 60 * 60 + 1); // 7 days + 1 second
      await expect(this.auction.connect(this.signers.alice).cancelAuction()).to.be.revertedWithCustomError(
        this.auction,
        "TooLate",
      );
    });
  });

  describe("Bidding process", function () {
    it("Should allow placing a bid", async function () {
      const bidAmount = 100n;
      const input = this.instance.createEncryptedInput(this.auctionAddress, this.signers.bob.address);
      input.add64(bidAmount);
      const encryptedBid = await input.encrypt();

      await expect(this.auction.connect(this.signers.bob).bid(encryptedBid.handles[0], encryptedBid.inputProof)).to.not
        .be.reverted;
    });

    it("Should allow multiple bids from the same user", async function () {
      // First bid
      const bidAmount1 = 50n;
      const input1 = this.instance.createEncryptedInput(this.auctionAddress, this.signers.bob.address);
      input1.add64(bidAmount1);
      const encryptedBid1 = await input1.encrypt();

      await this.auction.connect(this.signers.bob).bid(encryptedBid1.handles[0], encryptedBid1.inputProof);

      // Second bid
      const bidAmount2 = 30n;
      const input2 = this.instance.createEncryptedInput(this.auctionAddress, this.signers.bob.address);
      input2.add64(bidAmount2);
      const encryptedBid2 = await input2.encrypt();

      await expect(this.auction.connect(this.signers.bob).bid(encryptedBid2.handles[0], encryptedBid2.inputProof)).to
        .not.be.reverted;
    });

    it("Should not allow bids after auction ends", async function () {
      await time.increase(7 * 24 * 60 * 60 + 1); // 7 days + 1 second

      const bidAmount = 100n;
      const input = this.instance.createEncryptedInput(this.auctionAddress, this.signers.bob.address);
      input.add64(bidAmount);
      const encryptedBid = await input.encrypt();

      await expect(
        this.auction.connect(this.signers.bob).bid(encryptedBid.handles[0], encryptedBid.inputProof),
      ).to.be.to.be.revertedWithCustomError(this.auction, "TooLate");
    });

    it("Should allow claiming tokens after auction ends", async function () {
      // Place a bid first
      const bidAmount = 100n;
      const input = this.instance.createEncryptedInput(this.auctionAddress, this.signers.bob.address);
      input.add64(bidAmount);
      const encryptedBid = await input.encrypt();

      await this.auction.connect(this.signers.bob).bid(encryptedBid.handles[0], encryptedBid.inputProof);

      // Move time forward to end the auction
      await time.increase(7 * 24 * 60 * 60 + 1);

      // Claim tokens
      await expect(this.auction.connect(this.signers.bob).claimUser()).to.not.be.reverted;
    });

    it("Should not allow claiming before auction ends", async function () {
      // Place a bid
      const bidAmount = 100n;
      const input = this.instance.createEncryptedInput(this.auctionAddress, this.signers.bob.address);
      input.add64(bidAmount);
      const encryptedBid = await input.encrypt();

      await this.auction.connect(this.signers.bob).bid(encryptedBid.handles[0], encryptedBid.inputProof);

      // Try to claim immediately
      await expect(this.auction.connect(this.signers.bob).claimUser()).to.be.revertedWithCustomError(
        this.auction,
        "TooEarly",
      );
    });

    it("Should not allow bid when user has insufficient payment tokens", async function () {
      // Get initial token balances and auction state
      const initialTokensLeft = await this.auction.tokensLeftReveal();

      // Mint a small amount of tokens to Carol
      const USDC_CAROL_AMOUNT = 20n;
      const tx2 = await this.paymentToken.mint(this.signers.carol, USDC_CAROL_AMOUNT);
      const t2 = await tx2.wait();
      expect(t2?.status).to.eq(1);

      // Approve payment token for Carol (using the correct amount)
      const input = this.instance.createEncryptedInput(this.paymentTokenAddress, this.signers.carol.address);
      input.add64(USDC_CAROL_AMOUNT);
      const carolPaymentAmount = await input.encrypt();

      const txcarolApprove = await this.paymentToken
        .connect(this.signers.carol)
        ["approve(address,bytes32,bytes)"](
          this.auctionAddress,
          carolPaymentAmount.handles[0],
          carolPaymentAmount.inputProof,
        );
      await txcarolApprove.wait();

      // Try to place a bid larger than Carol's balance
      const bidAmount = 100n; // This will require more tokens than Carol has
      const input2 = this.instance.createEncryptedInput(this.auctionAddress, this.signers.carol.address);
      input2.add64(bidAmount);
      const encryptedBid = await input2.encrypt();

      // Expect the bid to be reverted due to insufficient balance
      await expect(this.auction.connect(this.signers.carol).bid(encryptedBid.handles[0], encryptedBid.inputProof));

      // Verify that the auction state hasn't changed
      await this.auction.connect(this.signers.alice).requestTokensLeftReveal();
      await awaitAllDecryptionResults();
      const finalTokensLeft = await this.auction.tokensLeftReveal();
      expect(finalTokensLeft).to.equal(initialTokensLeft);

      // Verify that no bid was recorded
      const [bidTokens, bidPaid] = await this.auction.connect(this.signers.carol).getUserBid();
      const decryptedBidTokens = await reencryptEuint64(
        this.signers.carol,
        this.instance,
        bidTokens,
        this.auctionAddress,
      );
      expect(decryptedBidTokens).to.equal(0n);
    });

    it("Should not process bid when user requests more than token amount", async function () {
      // Get initial token balances and auction state
      const initialTokensLeft = await this.auction.tokensLeftReveal();
      const initialPaymentBalance = await this.paymentToken.balanceOf(this.signers.bob);

      // Create a bid larger than Bob's approved amount
      const tokenAmount = TOKEN_AMOUNT + 1000n; // More than token amount
      const input = this.instance.createEncryptedInput(this.auctionAddress, this.signers.bob.address);
      input.add64(tokenAmount);
      const encryptedBid = await input.encrypt();

      // Place the bid
      await this.auction.connect(this.signers.bob).bid(encryptedBid.handles[0], encryptedBid.inputProof);

      // Request token reveal to check state
      await this.auction.connect(this.signers.alice).requestTokensLeftReveal();
      await awaitAllDecryptionResults();

      // Get final balances
      const finalTokensLeft = await this.auction.tokensLeftReveal();
      const finalPaymentBalance = await this.paymentToken.balanceOf(this.signers.bob);

      // Decrypt payment balances
      const decryptedInitialBalance = await reencryptEuint64(
        this.signers.bob,
        this.instance,
        initialPaymentBalance,
        this.paymentTokenAddress,
      );
      const decryptedFinalBalance = await reencryptEuint64(
        this.signers.bob,
        this.instance,
        finalPaymentBalance,
        this.paymentTokenAddress,
      );

      // Verify that no changes occurred
      expect(finalTokensLeft).to.equal(initialTokensLeft);
      expect(decryptedFinalBalance).to.equal(decryptedInitialBalance);

      // Verify that the bid was not recorded
      const [bidTokens, bidPaid] = await this.auction.connect(this.signers.bob).getUserBid();
      const decryptedBidTokens = await reencryptEuint64(
        this.signers.bob,
        this.instance,
        bidTokens,
        this.auctionAddress,
      );
      expect(decryptedBidTokens).to.equal(0n);
    });
  });

  describe("Token reveal functionality", function () {
    it("Should allow owner to request tokens left reveal", async function () {
      // Get Bob's initial balance
      //   const initialBobBalance = await this.paymentToken.balanceOf(this.signers.bob);
      //   const decryptedInitialBobBalance = await reencryptEuint64(
      //     this.signers.bob,
      //     this.instance,
      //     initialBobBalance,
      //     this.paymentTokenAddress,
      //   );
      //   console.log("Bob's initial balance:", decryptedInitialBobBalance.toString());

      // Place a bid first
      const bidAmount = 1n;

      const input = this.instance.createEncryptedInput(this.auctionAddress, this.signers.bob.address);
      input.add64(bidAmount);
      const encryptedBid = await input.encrypt();

      await this.auction.connect(this.signers.bob).bid(encryptedBid.handles[0], encryptedBid.inputProof);

      // Get Bob's balance after bid
      //   const afterBidBalance = await this.paymentToken.balanceOf(this.signers.bob);
      //   const decryptedAfterBidBalance = await reencryptEuint64(
      //     this.signers.bob,
      //     this.instance,
      //     afterBidBalance,
      //     this.paymentTokenAddress,
      //   );
      //   console.log("Bob's balance after bid:", decryptedAfterBidBalance.toString());

      // Get current price and calculate expected payment
      //   const currentPrice = await this.auction.getPrice();
      //   const expectedPayment = (currentPrice * bidAmount) / ethers.parseEther("1");
      //   // Calculate token cost at current price
      //   const tokenCost = currentPrice * bidAmount;
      //   console.log("Token cost:", tokenCost.toString());
      //   console.log("Expected payment:", expectedPayment.toString());

      // Request reveal
      await expect(this.auction.connect(this.signers.alice).requestTokensLeftReveal()).to.not.be.reverted;

      // Wait for decryption
      await awaitAllDecryptionResults();

      // Verify the revealed amount matches expected value
      const tokensLeftReveal = await this.auction.tokensLeftReveal();
      expect(tokensLeftReveal).to.equal(TOKEN_AMOUNT - bidAmount);

      // Get user bid information
      //   const [bidTokens, bidPaid] = await this.auction.connect(this.signers.bob).getUserBid();
      //   const decryptedBidTokens = await reencryptEuint64(
      //     this.signers.bob,
      //     this.instance,
      //     bidTokens,
      //     this.auctionAddress,
      //   );
      //   const decryptedBidPaid = await reencryptEuint64(this.signers.bob, this.instance, bidPaid, this.auctionAddress);
      //   console.log("Bid tokens:", decryptedBidTokens.toString());
      //   console.log("Bid paid:", decryptedBidPaid.toString());
    });

    it("Should not allow non-owner to request tokens left reveal", async function () {
      await expect(this.auction.connect(this.signers.bob).requestTokensLeftReveal()).to.be.reverted;
    });

    it("Should update tokensLeftReveal after multiple bids", async function () {
      // First bid
      const bidAmount1 = 50n;
      const input1 = this.instance.createEncryptedInput(this.auctionAddress, this.signers.bob.address);
      input1.add64(bidAmount1);
      const encryptedBid1 = await input1.encrypt();

      await this.auction.connect(this.signers.bob).bid(encryptedBid1.handles[0], encryptedBid1.inputProof);

      const oneDay = 24n * 60n * 60n;
      await time.increase(oneDay);

      // Second bid
      const bidAmount2 = 30n;
      const input2 = this.instance.createEncryptedInput(this.auctionAddress, this.signers.bob.address);
      input2.add64(bidAmount2);
      const encryptedBid2 = await input2.encrypt();

      await this.auction.connect(this.signers.bob).bid(encryptedBid2.handles[0], encryptedBid2.inputProof);

      // Request reveal
      await this.auction.connect(this.signers.alice).requestTokensLeftReveal();
      await awaitAllDecryptionResults();

      // Verify the revealed amount matches expected value after both bids
      const tokensLeftReveal = await this.auction.tokensLeftReveal();
      expect(tokensLeftReveal).to.equal(TOKEN_AMOUNT - (bidAmount1 + bidAmount2));
    });
  });

  describe("Token balance verification", function () {
    it("Should correctly transfer tokens after successful bid and claim", async function () {
      // Place a bid
      const bidAmount = 100n;
      const input = this.instance.createEncryptedInput(this.auctionAddress, this.signers.bob.address);
      input.add64(bidAmount);
      const encryptedBid = await input.encrypt();

      // Get initial balances
      const initialAuctionTokenAlice = await this.auctionToken.balanceOf(this.signers.alice);
      const initialPaymentTokenBob = await this.paymentToken.balanceOf(this.signers.bob);

      // Place bid
      await this.auction.connect(this.signers.bob).bid(encryptedBid.handles[0], encryptedBid.inputProof);

      // Move time forward to end the auction
      await time.increase(7 * 24 * 60 * 60 + 1);

      // Claim tokens
      await this.auction.connect(this.signers.bob).claimUser();
      await this.auction.connect(this.signers.alice).claimSeller();

      // Get final balances
      const finalAuctionTokenAlice = await this.auctionToken.balanceOf(this.signers.alice);
      const finalAuctionTokenBob = await this.auctionToken.balanceOf(this.signers.bob);
      const finalPaymentTokenAlice = await this.paymentToken.balanceOf(this.signers.alice);
      const finalPaymentTokenBob = await this.paymentToken.balanceOf(this.signers.bob);

      // Decrypt and verify balances
      const decryptedInitialAuctionTokenAlice = await reencryptEuint64(
        this.signers.alice,
        this.instance,
        initialAuctionTokenAlice,
        this.auctionTokenAddress,
      );
      const decryptedFinalAuctionTokenAlice = await reencryptEuint64(
        this.signers.alice,
        this.instance,
        finalAuctionTokenAlice,
        this.auctionTokenAddress,
      );

      const decryptedFinalAuctionTokenBob = await reencryptEuint64(
        this.signers.bob,
        this.instance,
        finalAuctionTokenBob,
        this.auctionTokenAddress,
      );

      const decryptedFinalPaymentTokenAlice = await reencryptEuint64(
        this.signers.alice,
        this.instance,
        finalPaymentTokenAlice,
        this.paymentTokenAddress,
      );
      const decryptedInitialPaymentTokenBob = await reencryptEuint64(
        this.signers.bob,
        this.instance,
        initialPaymentTokenBob,
        this.paymentTokenAddress,
      );
      const decryptedFinalPaymentTokenBob = await reencryptEuint64(
        this.signers.bob,
        this.instance,
        finalPaymentTokenBob,
        this.paymentTokenAddress,
      );

      // Verify auction token balances
      expect(decryptedInitialAuctionTokenAlice).to.equal(0n); // Alice transferred all tokens to auction contract
      expect(decryptedFinalAuctionTokenAlice).to.equal(TOKEN_AMOUNT - bidAmount);
      expect(decryptedFinalAuctionTokenBob).to.equal(bidAmount);

      // Calculate expected payment based on final price
      const finalPrice = await this.auction.getPrice();
      const expectedPayment = finalPrice * bidAmount;

      // Verify payment token balances
      expect(decryptedInitialPaymentTokenBob).to.equal(USDC_AMOUNT);
      expect(decryptedFinalPaymentTokenAlice).to.equal(expectedPayment);
      expect(decryptedFinalPaymentTokenBob).to.equal(USDC_AMOUNT - expectedPayment);
    });

    it("Should return tokens to seller after cancellation", async function () {
      // Get initial balance
      const initialAuctionTokenAlice = await this.auctionToken.balanceOf(this.signers.alice);

      // Cancel auction
      await this.auction.connect(this.signers.alice).cancelAuction();

      // Get final balance
      const finalAuctionTokenAlice = await this.auctionToken.balanceOf(this.signers.alice);

      // Decrypt and verify balances
      const decryptedInitialBalance = await reencryptEuint64(
        this.signers.alice,
        this.instance,
        initialAuctionTokenAlice,
        this.auctionTokenAddress,
      );
      const decryptedFinalBalance = await reencryptEuint64(
        this.signers.alice,
        this.instance,
        finalAuctionTokenAlice,
        this.auctionTokenAddress,
      );

      expect(decryptedInitialBalance).to.equal(0n); // All tokens in auction contract
      expect(decryptedFinalBalance).to.equal(TOKEN_AMOUNT); // All tokens returned
    });

    it("Should correctly handle refunds when bidding at different prices", async function () {
      // Place first bid at higher price
      const firstBidAmount = 50n;
      let input = this.instance.createEncryptedInput(this.auctionAddress, this.signers.bob.address);
      input.add64(firstBidAmount);
      let encryptedBid = await input.encrypt();

      // Get initial balance
      const initialPaymentTokenBob = await this.paymentToken.balanceOf(this.signers.bob);

      // Place first bid
      await this.auction.connect(this.signers.bob).bid(encryptedBid.handles[0], encryptedBid.inputProof);
      const firstBidPrice = await this.auction.getPrice();

      // Check first bid information
      const [firstBidTokens, firstBidPaid] = await this.auction.connect(this.signers.bob).getUserBid();
      const decryptedFirstBidTokens = await reencryptEuint64(
        this.signers.bob,
        this.instance,
        firstBidTokens,
        this.auctionAddress,
      );
      const decryptedFirstBidPaid = await reencryptEuint64(
        this.signers.bob,
        this.instance,
        firstBidPaid,
        this.auctionAddress,
      );
      expect(decryptedFirstBidTokens).to.equal(firstBidAmount);
      expect(decryptedFirstBidPaid).to.equal(firstBidPrice * firstBidAmount);

      // Move time forward to get a lower price
      await time.increase(3 * 24 * 60 * 60); // Move 3 days forward

      // Place second bid at lower price
      const secondBidAmount = 30n;
      input = this.instance.createEncryptedInput(this.auctionAddress, this.signers.bob.address);
      input.add64(secondBidAmount);
      encryptedBid = await input.encrypt();

      // Place second bid
      await this.auction.connect(this.signers.bob).bid(encryptedBid.handles[0], encryptedBid.inputProof);
      const secondBidPrice = await this.auction.getPrice();

      // Check combined bid information
      const [totalBidTokens, totalBidPaid] = await this.auction.connect(this.signers.bob).getUserBid();
      const decryptedTotalBidTokens = await reencryptEuint64(
        this.signers.bob,
        this.instance,
        totalBidTokens,
        this.auctionAddress,
      );
      const decryptedTotalBidPaid = await reencryptEuint64(
        this.signers.bob,
        this.instance,
        totalBidPaid,
        this.auctionAddress,
      );
      expect(decryptedTotalBidTokens).to.equal(firstBidAmount + secondBidAmount);
      // The total paid should be the sum of tokens at the second (lower) price
      expect(decryptedTotalBidPaid).to.equal(secondBidPrice * (firstBidAmount + secondBidAmount));

      // Move time to end of auction
      await time.increase(4 * 24 * 60 * 60 + 1);

      // Claim tokens and refunds
      await this.auction.connect(this.signers.bob).claimUser();
      await this.auction.connect(this.signers.alice).claimSeller();

      // Get final balances
      const finalPaymentTokenBob = await this.paymentToken.balanceOf(this.signers.bob);
      const finalPaymentTokenAlice = await this.paymentToken.balanceOf(this.signers.alice);

      // Decrypt balances
      const decryptedInitialPaymentTokenBob = await reencryptEuint64(
        this.signers.bob,
        this.instance,
        initialPaymentTokenBob,
        this.paymentTokenAddress,
      );
      const decryptedFinalPaymentTokenBob = await reencryptEuint64(
        this.signers.bob,
        this.instance,
        finalPaymentTokenBob,
        this.paymentTokenAddress,
      );
      const decryptedFinalPaymentTokenAlice = await reencryptEuint64(
        this.signers.alice,
        this.instance,
        finalPaymentTokenAlice,
        this.paymentTokenAddress,
      );

      // Calculate expected payments
      const finalPrice = await this.auction.getPrice();
      const totalTokens = firstBidAmount + secondBidAmount;
      const expectedPayment = finalPrice * totalTokens;

      // Verify payment token balances
      expect(decryptedInitialPaymentTokenBob).to.equal(USDC_AMOUNT);
      expect(decryptedFinalPaymentTokenAlice).to.be.closeTo(expectedPayment, USDC_AMOUNT / 100000000n);
      expect(decryptedFinalPaymentTokenBob).to.be.closeTo(USDC_AMOUNT - expectedPayment, USDC_AMOUNT / 100000000n);
    });
  });
});
